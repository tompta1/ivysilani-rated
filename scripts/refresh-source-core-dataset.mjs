import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

function parseArgs(argv) {
  const options = {}

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]

    if (!token.startsWith('--')) {
      continue
    }

    const [rawKey, inlineValue] = token.slice(2).split('=', 2)
    const next = argv[index + 1]
    const value =
      inlineValue !== undefined
        ? inlineValue
        : next !== undefined && !next.startsWith('--')
          ? (index += 1, next)
          : true

    options[rawKey] = value
  }

  return options
}

function runNode(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: process.env,
    })

    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(`${path.basename(scriptPath)} exited with code ${code}`))
    })

    child.on('error', reject)
  })
}

const options = parseArgs(process.argv.slice(2))
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const browserCaptureScript = path.join(scriptDir, 'capture-leaderboards-browser.mjs')
const curateScript = path.join(scriptDir, 'curate-leaderboards.mjs')
const enrichScript = path.join(scriptDir, 'enrich-ct-posters.mjs')
const buildCoreDatasetScript = path.join(scriptDir, 'build-source-core-dataset.mjs')
const date = typeof options.date === 'string' ? options.date : new Date().toISOString().slice(0, 10)
const outputFile =
  typeof options['output-file'] === 'string'
    ? path.resolve(options['output-file'])
    : path.join(process.cwd(), 'data', 'source-core-dataset.json')
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'ivysilani-rated-'))
const rawDir = path.join(tempRoot, 'raw')
const curatedDir = path.join(tempRoot, 'curated')
const generatedDir = path.join(tempRoot, 'generated')
const weightedFile = path.join(generatedDir, `weighted-seed-${date}.json`)
const postersFile = path.join(generatedDir, `ct-posters-${date}.json`)

try {
  await runNode(browserCaptureScript, [
    '--source',
    'all',
    '--date',
    date,
    '--raw-dir',
    rawDir,
  ])

  await runNode(curateScript, [
    'extract',
    '--source',
    'all',
    '--date',
    date,
    '--raw-dir',
    rawDir,
    '--curated-dir',
    curatedDir,
  ])

  await runNode(curateScript, [
    'merge',
    '--date',
    date,
    '--curated-dir',
    curatedDir,
    '--generated-dir',
    generatedDir,
  ])

  await runNode(enrichScript, ['--weighted-file', weightedFile, '--output-file', postersFile])
  await runNode(buildCoreDatasetScript, [
    '--weighted-file',
    weightedFile,
    '--posters-file',
    postersFile,
    '--output-file',
    outputFile,
  ])
} finally {
  await rm(tempRoot, { recursive: true, force: true })
}
