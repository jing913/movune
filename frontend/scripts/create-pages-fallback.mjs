import { copyFile } from 'node:fs/promises'

const outputDirectory = new URL('../dist/', import.meta.url)

await copyFile(new URL('index.html', outputDirectory), new URL('404.html', outputDirectory))
