export function streamResponse(frames: unknown[], split = 17): Response {
    const encoded = new TextEncoder().encode(frames.map(frame => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\r\n\r\n`).join(''))
    return new Response(new ReadableStream({start(controller) {
        for (let i = 0; i < encoded.length; i += split) controller.enqueue(encoded.slice(i, i + split))
        controller.close()
    }}), {headers: {'Content-Type': 'text/event-stream'}})
}
export function replyResponse(text = '已完成查询。'): Response {
    return streamResponse([{choices: [{delta: {content: text}, finish_reason: null}]}, {choices: [{delta: {}, finish_reason: 'stop'}]}, '[DONE]'])
}
