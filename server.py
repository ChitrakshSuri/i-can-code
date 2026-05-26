"""
FastAPI bridge between the React chat UI and the LangGraph backend.

Install deps:
  pip install fastapi uvicorn sse-starlette langchain-core

Run:
  uvicorn server:app --reload --port 8000
"""

import json
import asyncio
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from langchain_core.messages import HumanMessage, AIMessage, ToolMessage

# ── Import your LangGraph graph and helpers ────────────────────────────────
from langgraph_backend import chatbot, retrieve_all_threads

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # tighten in production
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Models ─────────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    thread_id: str
    message: str

# ── Routes ─────────────────────────────────────────────────────────────────

@app.get("/threads")
def get_threads():
    """Return list of all known thread IDs."""
    return retrieve_all_threads()


@app.get("/history/{thread_id}")
def get_history(thread_id: str):
    """Return the persisted message history for a thread."""
    try:
        state = chatbot.get_state(
            config={"configurable": {"thread_id": thread_id}}
        )
        messages = state.values.get("messages", [])
        result = []
        for msg in messages:
            if isinstance(msg, HumanMessage):
                result.append({"role": "user", "content": msg.content})
            elif isinstance(msg, AIMessage) and msg.content:
                result.append({"role": "assistant", "content": msg.content})
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/chat")
def chat_stream(req: ChatRequest):
    """
    Stream SSE events to the React frontend.

    Event shapes sent as JSON:
      { "type": "token",      "content": "..." }   — AI text token
      { "type": "tool_start", "content": "tool_name" }
      { "type": "tool_end",   "content": "tool_name" }
    Finishes with: data: [DONE]
    """
    config = {
        "configurable": {"thread_id": req.thread_id},
        "metadata":     {"thread_id": req.thread_id},
        "run_name":     "chat_turn",
    }

    def event_generator():
        active_tool = None

        try:
            for message_chunk, _ in chatbot.stream(
                {"messages": [HumanMessage(content=req.message)]},
                config=config,
                stream_mode="messages",
            ):
                if isinstance(message_chunk, ToolMessage):
                    tool_name = getattr(message_chunk, "name", "tool")

                    # Signal tool_start only once per tool invocation
                    if active_tool != tool_name:
                        if active_tool is not None:
                            yield f"data: {json.dumps({'type': 'tool_end', 'content': active_tool})}\n\n"
                        active_tool = tool_name
                        yield f"data: {json.dumps({'type': 'tool_start', 'content': tool_name})}\n\n"

                elif isinstance(message_chunk, AIMessage) and message_chunk.content:
                    # Close any open tool span before streaming tokens
                    if active_tool is not None:
                        yield f"data: {json.dumps({'type': 'tool_end', 'content': active_tool})}\n\n"
                        active_tool = None

                    yield f"data: {json.dumps({'type': 'token', 'content': message_chunk.content})}\n\n"

            # Close last tool span if stream ended while tool was active
            if active_tool is not None:
                yield f"data: {json.dumps({'type': 'tool_end', 'content': active_tool})}\n\n"

            yield "data: [DONE]\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'content': str(e)})}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",   # disable nginx buffering if proxied
        },
    )
