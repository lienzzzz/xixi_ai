import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(process.argv[2] ?? 'data/chat/xixi.sqlite');
const rows = db
  .prepare("select payload_json, timestamp from events where event_type = 'conversation.turn' order by sequence desc limit ?")
  .all(Number(process.argv[3] ?? 6)) as unknown as { payload_json: string; timestamp: string }[];
for (const row of rows.reverse()) {
  const payload = JSON.parse(row.payload_json) as {
    role: string;
    action: string;
    text: string | null;
    tool_name?: string | null;
  };
  console.log(`${row.timestamp} ${payload.role.padEnd(9)} ${payload.action.padEnd(6)} tool=${payload.tool_name ?? 'null'} | ${(payload.text ?? '').slice(0, 70)}`);
}
