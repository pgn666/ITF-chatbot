#ude Plan

## TODO

### Data Extraction

- Script to extract bibliography from thesis PDFs into metadata

### Local LLM Integration

- [x] Add connection to local LLM Studio (e.g. LM Studio REST API)
- [x] Use LLM to verify extracted metadata (abstract, keywords, english title, etc.)
- [x] If LLM-produced values differ from the ones already extracted by standard methods, write them to a separate `AI-metadata.json` — never override the original `metadata.json`

