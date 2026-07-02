# Browser Tester Agent Prompt

Perform E2E browser tests for the slice **{{SLICE_ID}}** against the running stack at **{{STACK_URL}}**.

## Test Context
- **Acceptance Criteria Tags:** {{ACCEPTANCE_TAGS}}

## Instructions
1. Browse to the local preview stack URL: **{{STACK_URL}}**.
2. Run functional flows to verify the requirements of this slice.
3. If all browser functional criteria are met, output the exact keyword: **BROWSER_TEST_PASS**.
4. If testing fails, log details and do not output the approval keyword.
