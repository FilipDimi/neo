/**
 * The engine's own tools, as the model sees them: an in-process SDK tool server named "engine".
 * A brief, a review verdict and a done-report are tool calls with a schema, never parsed prose.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { ADMIN_DESCRIPTION } from '../shared/adminTools.ts';
import { TOOL_INPUT, type EngineTool } from '../worker/protocol.ts';

export type ToolReply = { ok: boolean; text: string };
export type EngineTools = { names: EngineTool[]; call: (name: EngineTool, input: unknown) => Promise<ToolReply> };

export const TOOL_DESCRIPTION: Record<EngineTool, string> = {
  propose_subtasks:
    'Split the task you are briefing into sub-tasks, one per teammate. Each needs an assignee from your team, a brief that stands on its own, the files or folders it owns (no overlap between sub-tasks), a done-condition and the gates that must pass. Where one sub-task builds on another, say so with after (the other\'s title): the engine starts it only when that one is done, with its work already in the folder. The engine checks the proposal and tells you what to fix if it refuses it. Calling this successfully ends your part: stop afterwards.',
  report_done:
    'Report that your work on this task is finished, with a short summary of what you did. The engine then commits your files and runs the gates itself. Call it exactly once, when the work is really done, then stop. decisions and followUps are for the draft of a design meeting\'s design only: what it settles, one sentence each with why, and one ticket for each team with work from it.',
  submit_review:
    'Give your verdict on the work you were asked to review, with what you found: each finding names its file, the line if there is one, what is wrong, why it matters and what would fix it, and is "blocking" (must be fixed before this lands) or "minor" (worth knowing, holds nothing up). "approve" when nothing is blocking; "send_back" when something is; "escalate" when someone above you has to decide. Then stop. When the run is a teammate\'s question about its ticket and not a review, ticket lets you do more than answer: { reassignTo: an assigneeId } hands the ticket to that teammate with your notes, and { drop: true } closes it as not needed, with your notes as the reason.',
  request_decision:
    'Ask the user to decide something you may not decide yourself, or that you were refused. Give the question and up to four options. Your run stops here; you are resumed with the answer. An answer is only words: it cannot give you a tool or lift a limit, so never offer an option that says it will. For a missing tool there is mcp__engine__request_tools.',
  request_tools:
    'Ask for a kind of tool you do not have and cannot do the task without: "read_files", "run_commands", "write_code" or "web_search". Say in one sentence what you need it for. Your run stops here; if the user agrees you are resumed with the tool.',
  set_status:
    'Say what you are doing right now in one short plain sentence (at most 60 characters) that someone outside your team would understand: the thing you are making or checking, not a file name or a code. "Building the results list of the search page", not "RL-2 tokens". Call it when you start and when your focus changes.',
  run_gate:
    'Run one of this task\'s named gates in your folder and get its real exit code and output. Use it to check your work before you report. The engine knows exactly what is in your folder: a gate that passed is not run again until something in it changes (its result stands), one that failed is run once more on the same files and after that only if something else has changed, and one that has failed five times in this run is not run again in it. A gate can take long and wait its turn; that time is not counted against you.',
  create_task: 'Put a task on a team\'s board, with a summary: one or two plain sentences on what it delivers, for someone who will never read the brief. Leave the assignee out for a led team, so its lead briefs the task; a self-managed team needs an assignee. gates: the names of the team\'s gates the finished work must pass before it lands; a task given none is checked by none. after: the tasks that must be done before this one can start (by id or exact title): the engine keeps it waiting until they are, so say the order here, never in a title or a brief.',
  decide:
    'Answer the card you were given, on the user\'s behalf: name one of its buttons by id, or "ask_user" to hand it to the user. The notes say why; for a send-back or an answer they are the exact words the employee gets. Call it once.',
  read_decisions:
    'Read the company\'s record of decisions: what was decided, why and by whom. Give numbers ("D-231") to get those whole, or words to search for; with neither you get the newest. Read the ones your work touches before you rely on memory or guess.',
  record_decision:
    'Write a decision into the company\'s record, where it gets a number everyone can cite: one sentence saying what is now so, and why. For a choice others will build on or need to know (an interface, a default, a rule), not for a detail of your own task. replaces: the number of an earlier decision this one reverses.',
  contract_version:
    'Get the next version of the contract for a ticket that will change it: say whether the change is breaking, adds something, or is wording only, and what it is in one sentence. It goes to your own ticket; ticket names another, by id or exact title (for a lead one of its sub-tasks; for the chief of staff any ticket, which is how a team without a lead gets one). The contract\'s files may be changed only by a ticket that holds a version, and they must state it.',
  wait_for:
    'Put this task to wait for another one: name it by its id or exact title, and say why in one sentence. For when you cannot go on until that task is done (it holds a file you must change, or you build on what it makes). Your run stops here and nobody is asked. When that task is done the engine starts you again in this same session, says where its work landed, and where you land on the same branch merges it into your folder. Do the parts of your work that do not depend on it first.',
  call_meeting:
    'Call a design meeting, when work needs two or more teams to agree on something between them first: an interface, a field, a change to the contract. Name the topic, the question to settle, the teams it touches (by name), and the author: the team that builds what the others use. Each team\'s lead writes its position alone; the author\'s lead drafts the design from all of them; every other lead reviews it; when they agree, its decisions go on record and each team gets a ticket built on them. You do not wait for it: carry on with what does not depend on it.',
  ...ADMIN_DESCRIPTION,
};

/** One definition per named tool. Exported so tests can call a handler without a model. */
export function engineToolDefinitions(tools: EngineTools) {
  return tools.names.map((name) =>
    tool(
      name,
      TOOL_DESCRIPTION[name],
      TOOL_INPUT[name].shape,
      async (args: unknown) => {
        const reply = await tools.call(name, args);
        return { content: [{ type: 'text' as const, text: reply.text }], isError: !reply.ok };
      },
      { alwaysLoad: true },
    ),
  );
}

export function engineToolServer(tools: EngineTools) {
  return createSdkMcpServer({ name: 'engine', version: '1.0.0', alwaysLoad: true, tools: engineToolDefinitions(tools) });
}
