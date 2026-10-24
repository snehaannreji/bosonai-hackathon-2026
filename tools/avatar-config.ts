import { mkdirSync, writeFileSync } from "node:fs";
import { buildSessionConfig } from "../src/realtime/sessionConfig";
import dotenv from "dotenv";
import { readRealtimeSettings } from "../src/realtime/runtimeConfig";
dotenv.config();
// The isolated avatar spike has no learning tool executor yet. Do not offer
// a tool the agent cannot execute, or it will wait forever for a result.
const settings = readRealtimeSettings(process.env);
const config = buildSessionConfig(settings.model);
const session = config.session as Record<string, unknown>;
session.tools = [];
delete session.tool_choice;
mkdirSync("avatar", { recursive: true });
writeFileSync("avatar/session-config.json", JSON.stringify(config, null, 2));
console.log(`Wrote avatar/session-config.json for ${settings.model} with Alex's shared prompt (voice/video spike; learning tool disabled).`);
