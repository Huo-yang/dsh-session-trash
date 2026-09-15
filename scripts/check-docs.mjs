// Dependency-free validation of local Markdown links. Does not access the network.
import { readFile, readdir, access } from 'node:fs/promises'
import { dirname, extname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const skip = new Set(['node_modules', 'lib', '.git', 'work', '.dsh', '.dsh-test'])
async function markdownFiles(dir) {
  const files = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) files.push(...await markdownFiles(path))
    else if (entry.isFile() && extname(path) === '.md') files.push(path)
  }
  return files
}
function prose(text) {
  return text.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '')
}
function headings(text) {
  const found = new Set()
  const counts = new Map()
  for (const match of prose(text).matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const base = match[1].trim().toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s/g, '-')
    const count = counts.get(base) ?? 0
    counts.set(base, count + 1)
    found.add(count ? `${base}-${count}` : base)
  }
  return found
}
const errors = []
const files = await markdownFiles(root)
let checked = 0
for (const file of files) {
  const text = prose(await readFile(file, 'utf8'))
  for (const match of text.matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
    const url = match[1].trim().replace(/^<|>$/g, '')
    if (/^(?:[a-z]+:|\/\/)/i.test(url)) continue
    checked++
    const [path, anchor] = url.split('#')
    const target = path ? resolve(dirname(file), decodeURIComponent(path)) : file
    try {
      await access(target)
      if (anchor && extname(target) === '.md') {
        const ids = headings(await readFile(target, 'utf8'))
        if (!ids.has(decodeURIComponent(anchor))) throw new Error('heading not found')
      }
    } catch (error) {
      errors.push(`${relative(root, file)}: ${url} (${error.message})`)
    }
  }
}
if (errors.length) {
  console.error(errors.join('\n'))
  process.exitCode = 1
} else {
  console.log(`Documentation: ${files.length} Markdown files, ${checked} local links checked.`)
}
