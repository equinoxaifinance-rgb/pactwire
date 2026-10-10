"""Checks that the snippets in docs/FRAMEWORKS.md really connect to Pactwire.

Each framework connects to the hosted MCP server, lists its tools and calls one through the
framework's own tool interface, with no LLM and no API key. With --hire it also runs a whole
play-money deal through pactwire_try_hire against the live practice agents.

    python examples/frameworks/check_frameworks.py https://pactwire.neoaethel.workers.dev --hire
"""
import asyncio, json, sys

BASE = sys.argv[1].rstrip("/")
MCP_URL = f"{BASE}/mcp"
HIRE = "--hire" in sys.argv
DEAL = {
    "seller": "https://pactwire-fact-writer.neoaethel.workers.dev",
    "skill": "fact_sheet",
    "task": {"topic": "Agent escrow", "sourceText": "Agents can talk and pay. Nothing holds the money until the work is checked. Pactwire holds it and settles by rules both sides signed."},
    "priceCents": 100,
    "checks": [{"type": "count_at_least", "path": "facts", "min": 3}, {"type": "quotes_in_source", "path": "facts", "sourceTaskPath": "sourceText"}],
}
results = []


def text_of(result):
    """Pull the JSON text out of whatever shape a framework returns."""
    if isinstance(result, str):
        return result
    if isinstance(result, (list, tuple)):
        return "".join(text_of(r) for r in result)
    if isinstance(result, dict):
        return result.get("text") or json.dumps(result)
    return getattr(result, "text", None) or str(result)


async def openai_agents():
    # --- snippet: OpenAI Agents SDK ---
    from agents.mcp import MCPServerStreamableHttp
    async with MCPServerStreamableHttp(name="pactwire", params={"url": MCP_URL}, client_session_timeout_seconds=60) as pactwire:
        # agent = Agent(name="buyer", instructions="...", mcp_servers=[pactwire])
        tools = await pactwire.list_tools()
        # --- end snippet ---
        names = {t.name for t in tools}
        assert "pactwire_find_agents" in names, names
        out = await pactwire.call_tool("pactwire_try_hire" if HIRE else "pactwire_find_agents", DEAL if HIRE else {"query": "fact"})
        return names, text_of(out.content)


async def langchain():
    # --- snippet: LangChain / LangGraph ---
    from langchain_mcp_adapters.client import MultiServerMCPClient
    client = MultiServerMCPClient({"pactwire": {"url": MCP_URL, "transport": "streamable_http"}})
    tools = await client.get_tools()
    # agent = create_react_agent(model, tools)
    # --- end snippet ---
    by_name = {t.name: t for t in tools}
    assert "pactwire_find_agents" in by_name, by_name
    name = "pactwire_try_hire" if HIRE else "pactwire_find_agents"
    out = await by_name[name].ainvoke(DEAL if HIRE else {"query": "fact"})
    return set(by_name), text_of(out)


async def main():
    for name, fn in [("OpenAI Agents SDK", openai_agents), ("LangChain / LangGraph", langchain)]:
        try:
            names, out = await fn()
            ok = '"released"' in out if HIRE else True
            results.append((name, ok, f"{len(names)} tools; " + ("deal released" if ok and HIRE else out[:120].replace("\n", " "))))
        except Exception as e:  # report every framework, don't stop at the first failure
            results.append((name, False, f"{type(e).__name__}: {str(e)[:200]}"))
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}")
    sys.exit(0 if all(ok for _, ok, _ in results) else 1)


asyncio.run(main())
