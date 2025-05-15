/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { DidChangeTextDocumentParams, TextDocument, Uri, disposeAll, window, workspace } from 'coc.nvim'
import path from 'path'
import { CancellationToken, CancellationTokenSource, Disposable, Emitter, Event, TextDocumentContentChangeEvent } from 'vscode-languageserver-protocol'
import Proto from '../protocol'
import { ClientCapability, ITypeScriptServiceClient } from '../typescriptService'
import API from '../utils/api'
import { Delayer } from '../utils/async'
import { mode2ScriptKind } from '../utils/languageModeIds'
import { ResourceMap } from '../utils/resourceMap'
import * as typeConverters from '../utils/typeConverters'

const enum BufferKind {
  TypeScript = 1,
  JavaScript = 2,
}

const enum BufferState {
  Initial = 1,
  Open = 2,
  Closed = 2,
}

const enum BufferOperationType { Close, Open, Change }

class CloseOperation {
  readonly type = BufferOperationType.Close;
  constructor(
    public readonly args: string
  ) {}
}

class OpenOperation {
  readonly type = BufferOperationType.Open;
  constructor(
    public readonly args: Proto.OpenRequestArgs
  ) {}
}

class ChangeOperation {
  readonly type = BufferOperationType.Change;
  constructor(
    public readonly args: Proto.FileCodeEdits
  ) {}
}

type BufferOperation = CloseOperation | OpenOperation | ChangeOperation

let warningShown = false

function checkDocument(doc: { uri: string, languageId: string }): void {
  if (warningShown) return
  const { uri, languageId } = doc
  if ((uri.endsWith('.jsx') && languageId !== 'javascriptreact')
    || (uri.endsWith('.tsx') && languageId !== 'typescriptreact')) {
    let u = Uri.parse(doc.uri)
    let basename = path.basename(u.fsPath)
    if (doc.uri.endsWith('.jsx')) {
      window.showWarningMessage(`Possible wrong filetype "${doc.languageId}" with ${basename}, use javascriptreact as filetype to make tsserver work with react syntax.`)
    } else {
      window.showWarningMessage(`Possible wrong filetype "${doc.languageId}" with ${basename}, use typescriptreact as filetype to make tsserver work with react syntax.`)
    }
    warningShown = true
  }
}


class SyncedBuffer {

  private state = BufferState.Initial;

  constructor(
    private readonly document: TextDocument,
    public readonly filepath: string,
    private readonly client: ITypeScriptServiceClient,
    private readonly synchronizer: BufferSynchronizer,
  ) {}

  public open(): void {
    let folder = workspace.getWorkspaceFolder(this.document.uri)
    checkDocument(this.document)
    const args: Proto.OpenRequestArgs = {
      file: this.filepath,
      fileContent: this.document.getText(),
      projectRootPath: folder ? Uri.parse(folder.uri).fsPath : undefined
    }
    const scriptKind = mode2ScriptKind(this.document.languageId)
    if (scriptKind) {
      args.scriptKindName = scriptKind
    }

    if (this.client.apiVersion.gte(API.v240)) {
      // plugin managed.
      const tsPluginsForDocument = this.client.pluginManager.plugins
        .filter(x => x.languages.indexOf(this.document.languageId) >= 0)
      if (tsPluginsForDocument.length) {
        (args as any).plugins = tsPluginsForDocument.map(plugin => plugin.name)
      }
    }

    this.synchronizer.open(this.resource, args)
    this.state = BufferState.Open
  }

  public get resource(): string {
    return this.document.uri
  }

  public get lineCount(): number {
    return this.document.lineCount
  }

  public get kind(): BufferKind {
    if (this.document.languageId.startsWith('javascript')) {
      return BufferKind.JavaScript
    }
    return BufferKind.TypeScript
  }

  /**
   * @return Was the buffer open?
   */
  public close(): boolean {
    if (this.state !== BufferState.Open) {
      this.state = BufferState.Closed
      return false
    }
    this.state = BufferState.Closed
    return this.synchronizer.close(this.resource, this.filepath)
  }

  public onContentChanged(events: readonly TextDocumentContentChangeEvent[]): void {
    if (this.state !== BufferState.Open) {
      this.client.logger.error(`Unexpected buffer state: ${this.state}`)
    }
    this.synchronizer.change(this.resource, this.filepath, events)
  }
}

class SyncedBufferMap extends ResourceMap<SyncedBuffer> {

  public getForPath(filePath: string): SyncedBuffer | undefined {
    return this.get(Uri.file(filePath).toString())
  }

  public get allBuffers(): Iterable<SyncedBuffer> {
    return this.values
  }
}

class PendingDiagnostics extends ResourceMap<number> {
  public getOrderedFileSet(): ResourceMap<void> {
    const orderedResources = Array.from(this.entries)
      .sort((a, b) => a.value - b.value)
      .map(entry => entry.uri)

    const map = new ResourceMap<void>(this._normalizePath)
    for (const resource of orderedResources) {
      map.set(resource, undefined)
    }
    return map
  }
}

/**
 * Manages synchronization of buffers with the TS server.
 *
 * If supported, batches together file changes. This allows the TS server to more efficiently process changes.
 */
class BufferSynchronizer {

  private readonly _pending: ResourceMap<BufferOperation>

  constructor(
    private readonly client: ITypeScriptServiceClient,
    pathNormalizer: (path: string) => string | undefined
  ) {
    this._pending = new ResourceMap<BufferOperation>(pathNormalizer)
  }

  public open(resource: string, args: Proto.OpenRequestArgs) {
    if (this.supportsBatching) {
      this.updatePending(resource, new OpenOperation(args))
    } else {
      this.client.executeWithoutWaitingForResponse('open', args)
    }
  }

  /**
   * @return Was the buffer open?
   */
  public close(resource: string, filepath: string): boolean {
    if (this.supportsBatching) {
      return this.updatePending(resource, new CloseOperation(filepath))
    } else {
      const args: Proto.FileRequestArgs = { file: filepath }
      this.client.executeWithoutWaitingForResponse('close', args)
      return true
    }
  }

  public change(resource: string, filepath: string, events: readonly TextDocumentContentChangeEvent[]) {
    if (!events.length) {
      return
    }
    if (this.supportsBatching) {
      this.updatePending(resource, new ChangeOperation({
        fileName: filepath,
        textChanges: events.map((change): Proto.CodeEdit => ({
          newText: change.text,
          start: typeConverters.Position.toLocation((change as any).range.start),
          end: typeConverters.Position.toLocation((change as any).range.end),
        })).reverse(), // Send the edits end-of-document to start-of-document order
      }))
    } else {
      for (const { range, text } of events as any) {
        const args: Proto.ChangeRequestArgs = {
          insertString: text,
          ...typeConverters.Range.toFormattingRequestArgs(filepath, range)
        }
        this.client.executeWithoutWaitingForResponse('change', args)
      }
    }
  }

  public reset(): void {
    this._pending.clear()
  }

  public beforeCommand(command: string): void {
    if (command === 'updateOpen') {
      return
    }

    this.flush()
  }

  private flush() {
    if (!this.supportsBatching) {
      // We've already eagerly synchronized
      this._pending.clear()
      return
    }

    if (this._pending.size > 0) {
      const closedFiles: string[] = []
      const openFiles: Proto.OpenRequestArgs[] = []
      const changedFiles: Proto.FileCodeEdits[] = []
      for (const change of this._pending.values) {
        switch (change.type) {
          case BufferOperationType.Change: changedFiles.push(change.args); break
          case BufferOperationType.Open: openFiles.push(change.args); break
          case BufferOperationType.Close: closedFiles.push(change.args); break
        }
      }
      this.client.execute('updateOpen', { changedFiles, closedFiles, openFiles }, CancellationToken.None, { nonRecoverable: true }).catch(e => {
        this.client.logger.error(`Error on updateOpen:`, e)
      })
      this._pending.clear()
    }
  }

  private get supportsBatching(): boolean {
    return this.client.apiVersion.gte(API.v340)
  }

  private updatePending(resource: string, op: BufferOperation): boolean {
    switch (op.type) {
      case BufferOperationType.Close:
        const existing = this._pending.get(resource)
        switch (existing?.type) {
          case BufferOperationType.Open:
            this._pending.delete(resource)
            return false // Open then close. No need to do anything
        }
        break
    }

    if (this._pending.has(resource)) {
      // we saw this file before, make sure we flush before working with it again
      this.flush()
    }
    this._pending.set(resource, op)
    return true
  }
}

class GetErrRequest {

  public static executeGetErrRequest(
    client: ITypeScriptServiceClient,
    uris: Uri[],
    onDone: () => void
  ): GetErrRequest {
    const token = new CancellationTokenSource()
    return new GetErrRequest(client, uris, token, onDone)
  }

  private _done = false

  private constructor(
    private client: ITypeScriptServiceClient,
    public readonly uris: Uri[],
    private readonly _token: CancellationTokenSource,
    onDone: () => void
  ) {
    if (!this.isErrorReportingEnabled()) {
      this._done = true
      setImmediate(onDone)
      return
    }

    const supportsSyntaxGetErr = this.client.apiVersion.gte(API.v440)
    const allFiles = uris
      .filter(entry => supportsSyntaxGetErr || client.hasCapabilityForResource(entry, ClientCapability.Semantic))
      .map(entry => client.toTsFilePath(entry))

    if (!allFiles.length) {
      this._done = true
      setImmediate(onDone)
    } else {
      const request = this.areProjectDiagnosticsEnabled()
        // Note that geterrForProject is almost certainly not the api we want here as it ends up computing far
        // too many diagnostics
        ? client.executeAsync('geterrForProject', { delay: 0, file: allFiles[0] }, this._token.token)
        : client.executeAsync('geterr', { delay: 0, files: allFiles }, this._token.token)

      request.finally(() => {
        if (this._done) {
          return
        }
        this._done = true
        onDone()
      })
    }
  }

  public cancel(): any {
    if (!this._done) {
      this._token.cancel()
    }

    this._token.dispose()
  }

  private areProjectDiagnosticsEnabled() {
    return this.client.configuration.enableProjectDiagnostics && this.client.capabilities.has(ClientCapability.Semantic)
  }

  private isErrorReportingEnabled() {
    if (this.client.apiVersion.gte(API.v440)) {
      return true
    } else {
      // Older TS versions only support `getErr` on semantic server
      return this.client.capabilities.has(ClientCapability.Semantic)
    }
  }
}

export default class BufferSyncSupport {
  private disposables: Disposable[] = []
  private readonly client: ITypeScriptServiceClient

  private _validateJavaScript: boolean = true;
  private _validateTypeScript: boolean = true;
  private readonly modeIds: Set<string>
  private readonly syncedBuffers: SyncedBufferMap
  private readonly pendingDiagnostics: PendingDiagnostics
  private readonly diagnosticDelayer: Delayer<any>
  private pendingGetErr: GetErrRequest | undefined
  private listening: boolean = false;
  private readonly synchronizer: BufferSynchronizer

  private readonly _onDelete = new Emitter<string>()
  public readonly onDelete: Event<string> = this._onDelete.event
  readonly _onWillChange = new Emitter<string>()
  public readonly onWillChange: Event<string> = this._onWillChange.event

  constructor(
    client: ITypeScriptServiceClient,
    modeIds: readonly string[]
  ) {
    this.client = client
    this.modeIds = new Set<string>(modeIds)
    this.diagnosticDelayer = new Delayer<any>(300)
    const pathNormalizer = (path: string) => this.client.toPath(path)
    this.syncedBuffers = new SyncedBufferMap(pathNormalizer)
    this.pendingDiagnostics = new PendingDiagnostics(pathNormalizer)
    this.synchronizer = new BufferSynchronizer(client, pathNormalizer)
    this.updateConfiguration()
    workspace.onDidChangeConfiguration(this.updateConfiguration, this, this.disposables)
  }

  public listen(): void {
    if (this.listening) return
    this.listening = true
    workspace.onDidOpenTextDocument(
      this.openTextDocument,
      this,
      this.disposables
    )
    workspace.onDidCloseTextDocument(
      this.onDidCloseTextDocument,
      this,
      this.disposables
    )
    workspace.onDidChangeTextDocument(
      this.onDidChangeTextDocument,
      this,
      this.disposables
    )
    workspace.textDocuments.forEach(this.openTextDocument, this)
  }

  public handles(resource: string): boolean {
    return this.syncedBuffers.has(resource)
  }

  public dispose(): void {
    this.pendingDiagnostics.clear()
    disposeAll(this.disposables)
    this._onWillChange.dispose()
    this._onDelete.dispose()
  }

  public ensureHasBuffer(resource: string): boolean {
    if (this.syncedBuffers.has(resource)) {
      return true
    }

    const existingDocument = workspace.textDocuments.find(doc => doc.uri.toString() === resource)
    if (existingDocument) {
      return this.openTextDocument(existingDocument)
    }
    return false
  }

  public toResourceUri(resource: Uri): string {
    const filepath = this.client.toTsFilePath(resource);
    for (const buffer of this.syncedBuffers.allBuffers) {
      if (buffer.filepath != null && typeof filepath === 'string' && buffer.filepath === filepath) {
        return buffer.resource;
      }
    }
    return resource.toString()
  }

  public toResource(filePath: string): string {
    const buffer = this.syncedBuffers.getForPath(filePath)
    if (buffer) return buffer.resource
    return Uri.file(filePath).toString()
  }

  public reset(): void {
    this.pendingGetErr?.cancel()
    this.pendingDiagnostics.clear()
    this.synchronizer.reset()
  }

  public reinitialize(): void {
    this.reset()
    for (const buffer of this.syncedBuffers.allBuffers) {
      buffer.open()
    }
  }

  public openTextDocument(document: TextDocument): boolean {
    if (!this.modeIds.has(document.languageId)) {
      // can't handle
      return false
    }
    const resource = document.uri
    const filepath = this.client.toTsFilePath(Uri.parse(resource))
    if (!filepath) {
      return false
    }
    if (this.syncedBuffers.has(resource)) {
      return true
    }
    const syncedBuffer = new SyncedBuffer(document, filepath, this.client, this.synchronizer)
    this.syncedBuffers.set(resource, syncedBuffer)
    syncedBuffer.open()
    this.requestDiagnostic(syncedBuffer)
    return true
  }

  public closeResource(resource: string): void {
    const syncedBuffer = this.syncedBuffers.get(resource)
    if (!syncedBuffer) {
      return
    }
    this.pendingDiagnostics.delete(resource)
    this.syncedBuffers.delete(resource)
    const wasBufferOpen = syncedBuffer.close()
    this._onDelete.fire(resource)
    if (wasBufferOpen) {
      this.requestAllDiagnostics()
    }
  }

  private onDidCloseTextDocument(document: TextDocument): void {
    this.closeResource(document.uri)
  }

  private onDidChangeTextDocument(e: DidChangeTextDocumentParams): void {
    const syncedBuffer = this.syncedBuffers.get(e.textDocument.uri)
    if (!syncedBuffer) {
      return
    }
    this._onWillChange.fire(syncedBuffer.resource)
    syncedBuffer.onContentChanged(e.contentChanges)
    const didTrigger = this.requestDiagnostic(syncedBuffer)
    if (!didTrigger && this.pendingGetErr) {
      // In this case we always want to re-trigger all diagnostics
      this.pendingGetErr.cancel()
      this.pendingGetErr = undefined
      this.triggerDiagnostics()
    }
  }

  public beforeCommand(command: string): void {
    this.synchronizer.beforeCommand(command)
  }

  public interruptGetErr<R>(f: () => R): R {
    if (!this.pendingGetErr) {
      return f()
    }

    this.pendingGetErr.cancel()
    this.pendingGetErr = undefined
    const result = f()
    this.triggerDiagnostics()
    return result
  }

  public getErr(resources: Uri[]): any {
    const handledResources = resources.filter(resource => {
      let syncedBuffer = this.syncedBuffers.get(resource.toString())
      return syncedBuffer && this.shouldValidate(syncedBuffer)
    })
    if (!handledResources.length) {
      return
    }
    for (const resource of handledResources) {
      this.pendingDiagnostics.set(resource.toString(), Date.now())
    }
    this.triggerDiagnostics()
  }

  private triggerDiagnostics(delay: number = 200) {
    this.diagnosticDelayer.trigger(() => {
      this.sendPendingDiagnostics()
    }, delay)
  }

  public requestAllDiagnostics(): void {
    for (const buffer of this.syncedBuffers.allBuffers) {
      if (this.shouldValidate(buffer)) {
        this.pendingDiagnostics.set(buffer.resource, Date.now())
      }
    }
    this.triggerDiagnostics()
  }

  private requestDiagnostic(buffer: SyncedBuffer): boolean {
    if (!this.shouldValidate(buffer)) {
      return false
    }
    this.pendingDiagnostics.set(buffer.resource, Date.now())
    const delay = Math.min(Math.max(Math.ceil(buffer.lineCount / 20), 300), 800)
    this.triggerDiagnostics(delay)
    return true
  }

  public hasPendingDiagnostics(uri: string): boolean {
    return this.pendingDiagnostics.has(uri)
  }

  private sendPendingDiagnostics(): void {
    const orderedFileSet = this.pendingDiagnostics.getOrderedFileSet()
    if (this.pendingGetErr) {
      this.pendingGetErr.cancel()
      for (const uri of this.pendingGetErr.uris) {
        let resource = uri.toString()
        let syncedBuffer = this.syncedBuffers.get(resource)
        if (syncedBuffer && this.shouldValidate(syncedBuffer)) {
          orderedFileSet.set(resource, undefined)
        } else {
          orderedFileSet.delete(resource)
        }
      }
      this.pendingGetErr = undefined
    }
    // Add all open TS buffers to the geterr request. They might be visible
    for (const buffer of this.syncedBuffers.values) {
      if (this.shouldValidate(buffer)) {
        orderedFileSet.set(buffer.resource, undefined)
      }
    }
    if (orderedFileSet.size) {
      let uris = Array.from(orderedFileSet.uris).map(uri => Uri.parse(uri))
      const getErr = this.pendingGetErr = GetErrRequest.executeGetErrRequest(this.client, uris, () => {
        if (this.pendingGetErr === getErr) {
          this.pendingGetErr = undefined
        }
      })
    }

    this.pendingDiagnostics.clear()
  }

  private updateConfiguration(): void {
    const jsConfig = workspace.getConfiguration('javascript', null)
    const tsConfig = workspace.getConfiguration('typescript', null)
    this._validateJavaScript = jsConfig.get<boolean>('validate.enable', true)
    this._validateTypeScript = tsConfig.get<boolean>('validate.enable', true)
  }

  private shouldValidate(buffer: SyncedBuffer): boolean {
    switch (buffer.kind) {
      case BufferKind.JavaScript:
        return this._validateJavaScript

      case BufferKind.TypeScript:
      default:
        return this._validateTypeScript
    }
  }
}
