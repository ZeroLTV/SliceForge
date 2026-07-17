import fs from "node:fs";
import path from "node:path";
import Ajv from "ajv";

const schemaDirectory = path.resolve("src", "schemas");
const schemaNames = [
  "config.schema.json",
  "plan.schema.json",
  "agent-request.schema.json",
  "agent-response.schema.json",
  "visual-manifest.schema.json",
  "evaluation-suite.schema.json",
  "testcases.schema.json",
];

function readSchema(name) {
  return JSON.parse(fs.readFileSync(path.join(schemaDirectory, name), "utf8"));
}

const ajv = new Ajv({ allErrors: true, strict: true, strictRequired: false });
const responseSchema = readSchema("agent-response.schema.json");
ajv.addSchema(responseSchema, "agent-response.schema.json");

for (const name of schemaNames) {
  const schema = readSchema(name);
  if (name === "agent-response.schema.json") {
    ajv.getSchema(name);
  } else {
    ajv.compile(schema);
  }
  process.stdout.write(`compiled ${name}\n`);
}
