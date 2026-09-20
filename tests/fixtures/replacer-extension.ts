/**
 * B2b real-host acceptance fixture: a POST-HUD async `message_end` replacer.
 *
 * Loaded AFTER the HUD (`-e index.ts -e replacer-extension.ts`), it returns a
 * replacement assistant message with doubled usage numbers. Per the SDK's extension
 * runner, the final replacement is what enters history, so the session ledger must
 * count the doubled numbers - never the usage the HUD saw in its own message_end
 * event. The oracle over the session file proves which one was counted.
 *
 * Only assistant messages from the fixture provider are rewritten; everything else
 * passes through untouched.
 */
export default function replacerExtension(pi) {
  pi.on("message_end", async (event) => {
    const message = event?.message;
    if (!message || message.role !== "assistant" || message.provider !== "fixture") return undefined;
    if (!message.usage) return undefined;
    // Deliberately asynchronous: the replacement resolves after an await boundary, so
    // the final committed record lands after the HUD's own (synchronous) message_end
    // observation - the ordering the session ledger must tolerate.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const doubled = {
      input: message.usage.input * 2,
      output: message.usage.output * 2,
      cacheRead: message.usage.cacheRead * 2,
      cacheWrite: message.usage.cacheWrite * 2,
      totalTokens: (message.usage.totalTokens ?? 0) * 2,
      cost: message.usage.cost
        ? { ...message.usage.cost, total: message.usage.cost.total * 2 }
        : undefined,
    };
    return {
      message: {
        ...message,
        usage: doubled,
        content: [{ type: "text", text: `${typeof message.content?.[0]?.text === "string" ? message.content[0].text : ""} [replaced]` }],
      },
    };
  });
}
