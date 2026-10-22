type PendingHeader = {
  contentLength: number;
};

export class JsonRpcFramer {
  private buffer = Buffer.alloc(0);

  private pendingHeader: PendingHeader | null = null;

  public push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];

    while (true) {
      if (!this.pendingHeader) {
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          break;
        }

        const headerBuffer = this.buffer.subarray(0, headerEnd).toString("utf8");
        this.buffer = this.buffer.subarray(headerEnd + 4);
        this.pendingHeader = this.parseHeader(headerBuffer);
      }

      if (!this.pendingHeader || this.buffer.length < this.pendingHeader.contentLength) {
        break;
      }

      const body = this.buffer.subarray(0, this.pendingHeader.contentLength).toString("utf8");
      this.buffer = this.buffer.subarray(this.pendingHeader.contentLength);
      this.pendingHeader = null;
      messages.push(JSON.parse(body) as unknown);
    }

    return messages;
  }

  private parseHeader(headerText: string): PendingHeader {
    const headers = headerText.split("\r\n");
    const contentLengthHeader = headers.find((header) =>
      header.toLowerCase().startsWith("content-length:")
    );

    if (!contentLengthHeader) {
      throw new Error("Missing Content-Length header in LSP message.");
    }

    const contentLength = Number(contentLengthHeader.split(":")[1]?.trim());

    if (!Number.isFinite(contentLength) || contentLength < 0) {
      throw new Error("Invalid Content-Length header in LSP message.");
    }

    return {
      contentLength
    };
  }
}

export const encodeJsonRpcMessage = (payload: unknown): Buffer => {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "utf8");
  return Buffer.concat([header, body]);
};
