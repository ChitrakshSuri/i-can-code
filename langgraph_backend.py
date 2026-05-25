import os

from langgraph.graph import StateGraph, START, END
from typing import TypedDict, Annotated
from langchain_core.messages import BaseMessage, HumanMessage, AIMessage
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode, tools_condition
from langchain_community.tools import DuckDuckGoSearchRun
from langchain_core.tools import tool
from dotenv import load_dotenv
import sqlite3
import requests
from ddgs import DDGS

load_dotenv()

# -------------- LLM -----------------
llm = ChatOpenAI()

# ------------- Tools -----------------
search_tool = DuckDuckGoSearchRun(region="us-en")

@tool
def calculator(first_num: float, second_num: float, operation: str) -> dict:
    """Performs basic arithmetic operations on two numbers."""
    if operation == "add":
        result = first_num + second_num
    elif operation == "subtract":
        result = first_num - second_num
    elif operation == "multiply":
        result = first_num * second_num
    elif operation == "divide":
        if second_num == 0:
            return {"error": "Cannot divide by zero."}
        result = first_num / second_num
    else:
        return {"error": "Invalid operation. Supported operations are add, subtract, multiply, divide."}
    
    return {"result": result}
    
@tool
def get_stock_price(symbol: str) -> dict:
    """Fetches the current stock price for a given symbol uisng Alpha Vantage API."""
    url = f"https://finnhub.io/api/v1/quote?symbol={symbol}&token={os.getenv('FINNHUB_API_KEY')}"
    response = requests.get(url)
    return response.json()

tools = [search_tool, calculator, get_stock_price]
llm_with_tools = llm.bind_tools(tools)

# ------------- State -----------------
class ChatState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]

# ------------- Nodes -----------------
def chat_node(state: ChatState):
    messages = state['messages']
    response = llm_with_tools.invoke(messages)
    return {"messages": [response]}

tool_node = ToolNode(tools)

# ------------- Checkpointer -----------------
conn = sqlite3.connect(database='chatbot.db', check_same_thread=False)
checkpointer = SqliteSaver(conn=conn)

# ------------ Graph -----------------
graph = StateGraph(ChatState)
graph.add_node("chat_node", chat_node)
graph.add_node("tools", tool_node)

graph.add_edge(START, "chat_node")

graph.add_conditional_edges("chat_node",tools_condition)
graph.add_edge('tools', 'chat_node')

chatbot = graph.compile(checkpointer=checkpointer)

chatbot = graph.compile(checkpointer=checkpointer)

# ------------ Helper Functions -----------------
def retrieve_all_threads():
    all_threads = set()
    for checkpoint in checkpointer.list(None):
        all_threads.add(checkpoint.config['configurable']['thread_id'])

    return list(all_threads)

