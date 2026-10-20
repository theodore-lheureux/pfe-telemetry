---
name: documentation
description: Write, review or substantially revise repository Markdown documentation and READMEs using the project's structure, terminology and style conventions.
---

# Documentation

Apply these conventions to repository Markdown, including README files. Keep minor corrections focused; they do not require restructuring a page.

## Purpose and structure

Read related documentation and source before editing. Create a page only when it answers a concrete reader question. Choose its main purpose using [Diátaxis](https://diataxis.fr/); combine short supporting sections when they help the reader, without forcing a template or adding empty headings.

| Purpose     | Content                                                                             | Repository example                                            |
| ----------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Reference   | Definitions, fields, rules and examples needed to implement or configure something. | [Telemetry contract](../../../docs/telemetry-contract.md)     |
| How-to      | Prerequisites, steps and the expected result of a specific task.                    | [Test environment](../../../infra/test-environment/README.md) |
| Explanation | Mechanism, component relationships and constraints.                                 | [Architecture](../../../docs/architecture.md)                 |
| Decision    | Chosen approach, reasons, alternatives and consequences.                            | [Broker choice](../../../docs/broker-options.md)              |

README navigation can link these pages without adopting another pattern. Keep existing paths unless moving a page solves a navigation problem.

## Writing

- Open with useful information about the subject. Omit sentences such as "This document describes" or "This contract establishes".
- Use practical English, sentence-case headings and consistent terms: collector, ingestion service, storage worker, node, process, execution and test environment.
- Explain relationships in prose. Use tables for repeated fields or comparisons, and numbered steps for procedures.
- Preserve technical limits that affect correct use. Distinguish implemented behavior, selected designs and open choices through concrete wording.
- Omit marketing, vague filler, canned contrasts, research narration, authoring progress and lists of checks that were not performed. Keep a draft/version marker when it has a purpose.
- Link repeated detail to its authoritative page. Cite primary sources near external claims. Avoid duplicate link lists or unsupported performance promises.
- Show the repository's actual commands and settings, including Bun for JavaScript tooling. Do not introduce alternate setup helpers in documentation.

## Review

Preserve decisions, field names, commands, defaults, security boundaries and limitations. Check the edited text manually against related documentation and source, and review whether each section helps the reader implement, operate or understand the system. Update affected references when changing headings or paths.
