/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MarkupContent, MarkupKind } from 'vscode-languageserver-protocol'
import * as Proto from '../protocol'

function getTagBodyText(tag: Proto.JSDocTagInfo): string | undefined {
  if (!tag.text) {
    return undefined
  }

  switch (tag.name) {
    case 'example':
    case 'default':
      // Convert to markdown code block if it not already one
      if (tag.text.match(/^\s*[~`]{3}/g)) {
        return tag.text
      }
      return '```\n' + tag.text + '\n```'
  }

  return tag.text
}

function getTagDocumentation(tag: Proto.JSDocTagInfo): string | undefined {
  switch (tag.name) {
    case 'param':
      const body = (tag.text || '').split(/^([\w\.]+)\s*/)
      if (body && body.length === 3) {
        const param = body[1]
        const doc = body[2]
        const label = `*@${tag.name}* \`${param}\``
        if (!doc) {
          return label
        }
        return label + (doc.match(/\r\n|\n/g) ? '\n' + doc : ` — ${doc}`)
      }
  }

  // Generic tag
  const label = `*@${tag.name}*`
  const text = getTagBodyText(tag)
  if (!text) {
    return label
  }
  return label + (text.match(/\r\n|\n/g) ? '\n' + text : ` — ${text}`)
}

export function plain(parts: Proto.SymbolDisplayPart[]): string {
  if (!parts || !parts.length) return ''
  return parts.map(part => part.text).join('')
}

export function tagsMarkdownPreview(tags: Proto.JSDocTagInfo[]): string {
  return (tags || []).map(getTagDocumentation).join('  \n\n')
}

export function markdownDocumentation(
  documentation: Proto.SymbolDisplayPart[],
  tags: Proto.JSDocTagInfo[]
): MarkupContent {
  let out = plain(documentation)
  const tagsPreview = tagsMarkdownPreview(tags)
  if (tagsPreview) {
    out = out + ('\n\n' + tagsPreview)
  }
  return {
    kind: MarkupKind.Markdown,
    value: out
  }
}
