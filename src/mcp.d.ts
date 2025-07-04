import { Request, Response } from 'express';

declare module '@modelcontextprotocol/sdk/server' {
  export class Server {
    constructor(
      info: { name: string; version: string },
      config: {
        capabilities: {
          tools?: Record<string, {
            description: string;
            inputSchema: {
              type: string;
              properties: Record<string, any>;
              required: string[];
            };
          }>;
        };
      }
    );

    setRequestHandler(
      schema: any,
      handler: (request: any) => Promise<any>
    ): void;

    setToolHandler(
      name: string,
      handler: (args: any) => Promise<{
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      }>
    ): void;

    connect(transport: any): Promise<void>;
    close(): Promise<void>;
  }
}

declare module '@modelcontextprotocol/sdk/server/stdio' {
  export class StdioServerTransport {
    constructor();
  }
}

declare module '@modelcontextprotocol/sdk/server/sse' {
  export class SSEServerTransport {
    constructor(request: Request, response: Response);
  }
}

declare module '@modelcontextprotocol/sdk/types' {
  export const CallToolRequestSchema: any;
  export const ListToolsRequestSchema: any;
}