export async function readBoundedBody(request, maximumBytes) {
  const declaredLength = request.headers.get('content-length');
  if (/^\d+$/.test(declaredLength || '') && Number(declaredLength) > maximumBytes) {
    try {
      await request.body?.cancel('BODY_TOO_LARGE');
    } catch (_) {}
    throw new Error('BODY_TOO_LARGE');
  }

  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      byteLength += chunk.byteLength;
      if (byteLength > maximumBytes) {
        try {
          await reader.cancel('BODY_TOO_LARGE');
        } catch (_) {}
        throw new Error('BODY_TOO_LARGE');
      }
      chunks.push(chunk);
    }

    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    reader.releaseLock();
  }
}
