# TestGen Agent Prompt

Generate structured specification test cases for requirement tag **{{REQUIREMENT_TAG}}**.

## Specs Content
{{DOCS_CONTENT}}

## Instructions
1. Parse specifications and derive E2E test scenarios.
2. Structure them in valid JSON format.
3. Save the resulting JSON file to: **{{ARTIFACT_PATH}}**.
4. Output the exact keyword: **TESTGEN_COMPLETE** once done.
