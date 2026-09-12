import { BuiltInAgent } from "@copilotkit/runtime/v2";
import { resolveModel } from "./model";

/**
 * The agent factory.
 *
 * Return a FRESH agent per threadId — never share one stateful instance across
 * conversations. Channels clones the agent per turn anyway, but a factory is the
 * documented shape and keeps per-thread state honest.
 *
 * To swap in LangGraph, CrewAI, Mastra, Pydantic AI, or Google ADK, replace the
 * body with an HttpAgent pointed at your agent's AG-UI endpoint:
 *
 *   import { HttpAgent } from "@ag-ui/client";
 *   return new HttpAgent({ url: process.env.AGENT_URL! });
 *
 * Nothing else in the kit changes. That is the point of AG-UI.
 */
export type AgentFactoryOptions = {
  /**
   * The system prompt. Required: every surface states its own, so there is no
   * shared default that could silently apply to an agent that forgot to set one.
   */
  prompt: string;
};

export function makeAgent(threadId: string, options: AgentFactoryOptions) {
  const agent = new BuiltInAgent({
    model: resolveModel(),
    prompt: options.prompt,

    // NOT optional in practice. maxSteps defaults to 1, which means the agent
    // can call one tool and then stops — before it ever sees the result. Any
    // agent with tools needs room to loop.
    maxSteps: 10,
  });
  agent.threadId = threadId;
  return agent;
}
