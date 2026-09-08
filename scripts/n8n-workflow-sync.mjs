#!/usr/bin/env node
// Keeps an n8n workflow's Code-node JavaScript in standalone, git-diffable
// .js files instead of buried inside one long JSON string.
//
// `extract` splits a deployed workflow export into workflow.json (the same
// export with each Code node's jsCode blanked out) plus one <node name>.js
// file per Code node. `build` does the reverse: it folds those .js files
// back into workflow.json to produce the exact JSON n8n expects. Run
// `prettier --write` over both directions afterward - this script only
// moves text around, it never reformats it.
//
// Usage:
//   node scripts/n8n-workflow-sync.mjs extract <workflow.json> <dest-dir>
//   node scripts/n8n-workflow-sync.mjs build <source-dir> <output-file>

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs"
import { join } from "node:path"

const CODE_NODE_TYPE = "n8n-nodes-base.code"

function usageError() {
  console.error(
    "Usage:\n" +
      "  node scripts/n8n-workflow-sync.mjs extract <workflow.json> <dest-dir>\n" +
      "  node scripts/n8n-workflow-sync.mjs build <source-dir> <output-file>"
  )
  process.exit(1)
}

function codeNodes(workflow) {
  return (workflow.nodes ?? []).filter((node) => node.type === CODE_NODE_TYPE)
}

function extract(workflowPath, destDir) {
  const workflow = JSON.parse(readFileSync(workflowPath, "utf8"))
  mkdirSync(destDir, { recursive: true })

  for (const node of codeNodes(workflow)) {
    const code = node.parameters.jsCode ?? ""
    writeFileSync(
      join(destDir, `${node.name}.js`),
      code.endsWith("\n") ? code : code + "\n"
    )
    node.parameters.jsCode = ""
  }

  writeFileSync(
    join(destDir, "workflow.json"),
    JSON.stringify(workflow, null, 2) + "\n"
  )
}

function build(sourceDir, outputFile) {
  const workflow = JSON.parse(
    readFileSync(join(sourceDir, "workflow.json"), "utf8")
  )
  const jsFiles = new Set(
    readdirSync(sourceDir).filter((f) => f.endsWith(".js"))
  )

  for (const node of codeNodes(workflow)) {
    const filename = `${node.name}.js`
    if (!jsFiles.has(filename)) {
      console.error(
        `Missing source file for Code node "${node.name}": expected ${join(sourceDir, filename)}`
      )
      process.exit(1)
    }
    const code = readFileSync(join(sourceDir, filename), "utf8")
    // jsCode is a bare function body, not a file - normalize to exactly one
    // trailing newline regardless of what the formatted .js file ends with.
    node.parameters.jsCode = code.replace(/\n+$/, "\n")
    jsFiles.delete(filename)
  }

  if (jsFiles.size > 0) {
    console.error(
      `Unused .js file(s) in ${sourceDir} with no matching Code node: ${[...jsFiles].join(", ")}\n` +
        "Rename or delete them - a stale file here silently stops shipping."
    )
    process.exit(1)
  }

  writeFileSync(outputFile, JSON.stringify(workflow, null, 2) + "\n")
}

const [, , command, arg1, arg2] = process.argv
if (!arg1 || !arg2) usageError()

if (command === "extract") {
  extract(arg1, arg2)
} else if (command === "build") {
  build(arg1, arg2)
} else {
  usageError()
}
