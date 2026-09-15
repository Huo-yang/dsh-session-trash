import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, 'dist')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const expectedTag = `v${pkg.version}`
const requestedTag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : process.argv[2]

assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'package version must be valid semver')
if (requestedTag !== undefined) assert.equal(requestedTag, expectedTag, `tag must equal ${expectedTag}`)

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })
const preview = JSON.parse(await captureNpm(['pack', '--dry-run', '--json', '--ignore-scripts'], root))[0]
const packedFiles = new Set(preview.files.map(file => file.path))
for (const required of ['package.json', 'lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'README.md', 'README.en.md', 'LICENSE', 'CHANGELOG.md']) {
  assert.ok(packedFiles.has(required), `release package is missing ${required}`)
}
assert.ok([...packedFiles].some(file => file.startsWith('docs/')), 'release package is missing docs')
assert.ok(![...packedFiles].some(file => file.startsWith('src/') || file.startsWith('scripts/')), 'release package must not include source or development scripts')
await runNpm(['pack', '--ignore-scripts', '--pack-destination', 'dist'], root)

const archives = (await readdir(outDir)).filter(name => name.endsWith('.tgz'))
assert.deepEqual(archives, [`${pkg.name}-${pkg.version}.tgz`])
const archive = archives[0]
const digest = createHash('sha256').update(await readFile(join(outDir, archive))).digest('hex')
await writeFile(join(outDir, 'SHA256SUMS.txt'), `${digest}  ${archive}\n`, 'utf8')
await writeFile(join(outDir, 'release-manifest.json'), `${JSON.stringify({ name: pkg.name, version: pkg.version, tag: expectedTag, archive, sha256: digest }, null, 2)}\n`, 'utf8')
console.log(`[release] ${archive}`)
console.log(`[release] sha256 ${digest}`)

function run(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with ${code}`)))
  })
}

function capture(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolvePromise(stdout) : reject(new Error(`${command} exited with ${code}: ${stderr}`)))
  })
}

function captureNpm(args, cwd) {
  if (process.platform !== 'win32') return capture('npm', args, cwd)
  return capture(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`], cwd)
}

function runNpm(args, cwd) {
  if (process.platform !== 'win32') return run('npm', args, cwd)
  return run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`], cwd)
}
