export interface ParsedToolCall {
  name: string;
  args: Record<string, any>;
}

export class ResponseParser {
  private buffer: string = "";
  private emittedTextLen: number = 0;
  private emittedFunctionCall: boolean = false;
  private toolCalls: ParsedToolCall[] = [];

  /**
   * Processes incoming text deltas from Gemini Web and returns formatted GenAI SSE data chunks.
   * Safely holds back partial code fences so tool calls are never leaked as plain text.
   */
  public parseChunk(delta: string, isThought: boolean = false): string[] {
    const sseEvents: string[] = [];

    // If Google's internal stream flagged this chunk as thought
    if (isThought) {
      sseEvents.push(this.formatSsePart({ text: delta, thought: true }));
      return sseEvents;
    }

    this.buffer += delta;

    // 1. Check for a completed function_call fence or raw tool JSON in buffer
    const toolCallMatch = this.extractFunctionCall(this.buffer);
    if (toolCallMatch && !this.emittedFunctionCall) {
      this.emittedFunctionCall = true;
      this.toolCalls.push(toolCallMatch);
      sseEvents.push(this.formatSseFunctionCall(toolCallMatch));
      return sseEvents;
    }

    if (this.emittedFunctionCall) {
      return sseEvents;
    }

    // 2. Check if we are inside or starting a potential tool call fence
    const unemitted = this.buffer.slice(this.emittedTextLen);
    const fenceStartIdx = this.buffer.indexOf("```function_call");
    const altFenceStartIdx = this.buffer.indexOf("```tool_call");
    const activeFenceIdx = fenceStartIdx !== -1 ? fenceStartIdx : altFenceStartIdx;

    if (activeFenceIdx !== -1) {
      // Emit any text that occurred strictly before the tool fence opened
      if (activeFenceIdx > this.emittedTextLen) {
        const preText = this.buffer.slice(this.emittedTextLen, activeFenceIdx);
        this.emittedTextLen = activeFenceIdx;
        if (preText) {
          sseEvents.push(this.formatSsePart({ text: preText }));
        }
      }
      // Hold back everything from the opening fence until extractFunctionCall succeeds or finalize() runs
      return sseEvents;
    }

    // 3. Guard against split opening fences across chunks (e.g. "`", "``", "```f", "```func")
    const partialFenceMatch = unemitted.match(/`{1,3}(?:f(?:u(?:n(?:c(?:t(?:i(?:o(?:n(?:_(?:c(?:a(?:l(?:l)?)?)?)?)?)?)?)?)?)?)?)?|t(?:o(?:o(?:l(?:_(?:c(?:a(?:l(?:l)?)?)?)?)?)?)?)?)?$/);
    if (partialFenceMatch && partialFenceMatch.index !== undefined) {
      const safeText = unemitted.slice(0, partialFenceMatch.index);
      if (safeText.length > 0) {
        this.emittedTextLen += safeText.length;
        sseEvents.push(this.formatSsePart({ text: safeText }));
      }
      return sseEvents;
    }

    // 4. Safe to stream all unemitted text
    if (unemitted.length > 0) {
      this.emittedTextLen = this.buffer.length;
      sseEvents.push(this.formatSsePart({ text: unemitted }));
    }

    return sseEvents;
  }

  /**
   * Flushes any remaining buffer at the end of generation.
   */
  public finalize(modelVersion: string = "gemini-4-argon"): string[] {
    const sseEvents: string[] = [];

    // Final check for tool call
    if (!this.emittedFunctionCall) {
      const toolCallMatch = this.extractFunctionCall(this.buffer);
      if (toolCallMatch) {
        this.emittedFunctionCall = true;
        this.toolCalls.push(toolCallMatch);
        sseEvents.push(this.formatSseFunctionCall(toolCallMatch));
      } else if (this.emittedTextLen < this.buffer.length) {
        // Flush any held-back text that turned out not to be a valid tool call
        const remaining = this.buffer.slice(this.emittedTextLen);
        this.emittedTextLen = this.buffer.length;
        if (remaining) {
          sseEvents.push(this.formatSsePart({ text: remaining }));
        }
      }
    }

    // Emit final finishReason STOP
    const finishPayload = {
      response: {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "" }],
            },
            finishReason: "STOP",
          },
        ],
        modelVersion,
      },
    };

    sseEvents.push(`data: ${JSON.stringify(finishPayload)}\n\n`);
    return sseEvents;
  }

  private extractFunctionCall(text: string): ParsedToolCall | null {
    // Strategy 1: ```function_call\n{...}\n```
    const regexFence = /```(?:function_call|tool_call|json)\s*([\s\S]*?)```/gi;
    let match: RegExpExecArray | null;
    while ((match = regexFence.exec(text)) !== null) {
      if (match[1]) {
        const parsed = this.tryParseToolJson(match[1].trim());
        if (parsed) return parsed;
      }
    }

    // Strategy 2: Balanced brace extraction for raw {"name": "...", "args": {...}}
    const nameMarker = /\{\s*"name"\s*:\s*"([a-zA-Z0-9_-]+)"\s*,\s*"(?:args|parameters)"\s*:/g;
    let rawMatch: RegExpExecArray | null;
    while ((rawMatch = nameMarker.exec(text)) !== null) {
      const startIdx = rawMatch.index;
      const balanced = this.extractBalancedJson(text, startIdx);
      if (balanced) {
        const parsed = this.tryParseToolJson(balanced);
        if (parsed) return parsed;
      }
    }

    return null;
  }

  private tryParseToolJson(raw: string): ParsedToolCall | null {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.name === "string" && (parsed.args !== undefined || parsed.parameters !== undefined)) {
        return {
          name: parsed.name,
          args: parsed.args ?? parsed.parameters ?? {},
        };
      }
      if (parsed?.functionCall && typeof parsed.functionCall.name === "string") {
        return {
          name: parsed.functionCall.name,
          args: parsed.functionCall.args ?? {},
        };
      }
    } catch {
      // Incomplete or invalid JSON
    }
    return null;
  }

  private extractBalancedJson(text: string, startIndex: number): string | null {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = startIndex; i < text.length; i++) {
      const ch = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\" && inString) {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            return text.slice(startIndex, i + 1);
          }
        }
      }
    }
    return null;
  }

  private formatSsePart(part: { text?: string; thought?: boolean }): string {
    const payload = {
      response: {
        candidates: [
          {
            content: {
              role: "model",
              parts: [part],
            },
          },
        ],
      },
    };
    return `data: ${JSON.stringify(payload)}\n\n`;
  }

  private formatSseFunctionCall(toolCall: ParsedToolCall): string {
    const payload = {
      response: {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  functionCall: {
                    name: toolCall.name,
                    args: toolCall.args,
                  },
                },
              ],
            },
          },
        ],
      },
    };
    return `data: ${JSON.stringify(payload)}\n\n`;
  }

  public getBuffer(): string {
    return this.buffer;
  }

  public getToolCalls(): ParsedToolCall[] {
    return this.toolCalls;
  }
}
