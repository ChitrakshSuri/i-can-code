import os
import asyncio
import sqlite3
import requests

from langgraph.graph import StateGraph, START, END
from typing import TypedDict, Annotated
from langchain_core.messages import BaseMessage, HumanMessage, AIMessage
from langchain_core.tools import tool, BaseTool
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode, tools_condition
from langchain_community.tools import DuckDuckGoSearchRun
from langchain_mcp_adapters.client import MultiServerMCPClient
from dotenv import load_dotenv

load_dotenv()

# -------------- Async helper -----------------------------------------
# MCP's get_tools() is async; this lets us call it from sync code safely.

def run_async(coro):
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor() as pool:
                return pool.submit(asyncio.run, coro).result()
        return loop.run_until_complete(coro)
    except RuntimeError:
        return asyncio.run(coro)

# -------------- LLM --------------------------------------------------
llm = ChatOpenAI()

# ------------- Built-in tools ----------------------------------------
search_tool = DuckDuckGoSearchRun(region="us-en")

@tool
def calculator(first_num: float, second_num: float, operation: str) -> dict:
    """Performs basic arithmetic operations on two numbers."""
    ops = {
        "add":      lambda a, b: a + b,
        "subtract": lambda a, b: a - b,
        "multiply": lambda a, b: a * b,
        "divide":   lambda a, b: {"error": "Cannot divide by zero."} if b == 0 else a / b,
    }
    if operation not in ops:
        return {"error": "Invalid operation. Supported: add, subtract, multiply, divide."}
    result = ops[operation](first_num, second_num)
    return result if isinstance(result, dict) else {"result": result}

@tool
def get_stock_price(symbol: str) -> dict:
    """Fetches the current stock price for a given symbol using Finnhub API."""
    url = f"https://finnhub.io/api/v1/quote?symbol={symbol}&token={os.getenv('FINNHUB_API_KEY')}"
    response = requests.get(url)
    return response.json()

# ------------- MCP client & tools ------------------------------------
MCP_SERVER_URL = os.getenv("CANDOUR_DB_MCP_URL")

client = MultiServerMCPClient(
    {
        "candour-db-mcp": {
            "transport": "streamable_http",
            "url": MCP_SERVER_URL,
        }
    }
) if MCP_SERVER_URL else None

def load_mcp_tools() -> list[BaseTool]:
    if client is None:
        print("[WARN] CANDOUR_DB_MCP_URL is not set; MCP tools disabled.")
        return []
    try:
        return run_async(client.get_tools())
    except Exception as e:
        print(f"[WARN] Could not load MCP tools: {e}")
        return []

mcp_tools = load_mcp_tools()  # ← was defined but never called before

# ------------- All tools ---------------------------------------------
tools = [search_tool, calculator, get_stock_price, *mcp_tools]
llm_with_tools = llm.bind_tools(tools) if tools else llm

print(f"[INFO] Loaded {len(tools)} tools: {[t.name for t in tools]}")

# ------------- State -------------------------------------------------
class ChatState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]

# ------------- Nodes -------------------------------------------------
def chat_node(state: ChatState):
    messages = state['messages']
    response = llm_with_tools.invoke(messages)
    return {"messages": [response]}

tool_node = ToolNode(tools)

# ------------- Checkpointer ------------------------------------------
conn = sqlite3.connect(database="chatbot.db", check_same_thread=False)
checkpointer = SqliteSaver(conn=conn)

# ------------- Graph -------------------------------------------------
graph = StateGraph(ChatState)
graph.add_node("chat_node", chat_node)
graph.add_node("tools", tool_node)

graph.add_edge(START, "chat_node")
graph.add_conditional_edges("chat_node", tools_condition)
graph.add_edge("tools", "chat_node")

chatbot = graph.compile(checkpointer=checkpointer)

# ------------- Helper functions --------------------------------------
def retrieve_all_threads() -> list[str]:
    all_threads = set()
    for checkpoint in checkpointer.list(None):
        all_threads.add(checkpoint.config["configurable"]["thread_id"])
    return list(all_threads)
