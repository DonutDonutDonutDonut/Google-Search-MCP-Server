import { Server } from '@modelcontextprotocol/sdk/server/index.js';
// Make sure you import the correct transport
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { GoogleSearchService } from './services/google-search.service.js';
import { ContentExtractor } from './services/content-extractor.service.js';
import { OutputFormat } from './types.js';
import express from 'express';
import cors from 'cors';

class GoogleSearchServer {
  private server: Server;
  private searchService: GoogleSearchService;
  private contentExtractor: ContentExtractor;
  private app: express.Application;
  private port: number;

  // 1. Add a map to store active transport sessions
  private transports = new Map<string, SSEServerTransport>();

  constructor(port: number = 3000) {
    this.port = port;
    this.searchService = new GoogleSearchService();
    this.contentExtractor = new ContentExtractor();
    this.app = express();

    this.app.use(cors());
    this.app.use(express.json());

    this.server = new Server(
      {
        name: 'google-search',
        version: '1.0.0'
      },
      {
        capabilities: {
          tools: {
            google_search: {
              description: 'Search Google and return relevant results from the web. This tool finds web pages, articles, and information on specific topics using Google\'s search engine. Results include titles, snippets, and URLs that can be analyzed further using extract_webpage_content.',
              inputSchema: {
                type: 'object',
                properties: {
                  query: {
                    type: 'string',
                    description: 'Search query - be specific and use quotes for exact matches. For best results, use clear keywords and avoid very long queries.'
                  },
                  num_results: {
                    type: 'number',
                    description: 'Number of results to return (default: 5, max: 10). Increase for broader coverage, decrease for faster response.'
                  },
                  site: {
                    type: 'string',
                    description: 'Limit search results to a specific website domain (e.g., "wikipedia.org" or "nytimes.com").'
                  },
                  language: {
                    type: 'string',
                    description: 'Filter results by language using ISO 639-1 codes (e.g., "en" for English, "es" for Spanish, "fr" for French).'
                  },
                  dateRestrict: {
                    type: 'string',
                    description: 'Filter results by date using Google\'s date restriction format: "d[number]" for past days, "w[number]" for past weeks, "m[number]" for past months, or "y[number]" for past years. Example: "m6" for results from the past 6 months.'
                  },
                  exactTerms: {
                    type: 'string',
                    description: 'Search for results that contain this exact phrase. This is equivalent to putting the terms in quotes in the search query.'
                  },
                  resultType: {
                    type: 'string',
                    description: 'Specify the type of results to return. Options include "image" (or "images"), "news", and "video" (or "videos"). Default is general web results.'
                  },
                  page: {
                    type: 'number',
                    description: 'Page number for paginated results (starts at 1). Use in combination with resultsPerPage to navigate through large result sets.'
                  },
                  resultsPerPage: {
                    type: 'number',
                    description: 'Number of results to show per page (default: 5, max: 10). Controls how many results are returned for each page.'
                  },
                  sort: {
                    type: 'string',
                    description: 'Sorting method for search results. Options: "relevance" (default) or "date" (most recent first).'
                  }
                },
                required: ['query']
              }
            },
            extract_webpage_content: {
              description: 'Extract and analyze content from a webpage, converting it to readable text. This tool fetches the main content while removing ads, navigation elements, and other clutter. Use it to get detailed information from specific pages found via google_search. Works with most common webpage formats including articles, blogs, and documentation.',
              inputSchema: {
                type: 'object',
                properties: {
                  url: {
                    type: 'string',
                    description: 'Full URL of the webpage to extract content from (must start with http:// or https://). Ensure the URL is from a public webpage and not behind authentication.'
                  },
                  format: {
                    type: 'string',
                    description: 'Output format for the extracted content. Options: "markdown" (default), "html", or "text".'
                  }
                },
                required: ['url']
              }
            },
            extract_multiple_webpages: {
              description: 'Extract and analyze content from multiple webpages in a single request. This tool is ideal for comparing information across different sources or gathering comprehensive information on a topic. Limited to 5 URLs per request to maintain performance.',
              inputSchema: {
                type: 'object',
                properties: {
                  urls: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Array of webpage URLs to extract content from. Each URL must be public and start with http:// or https://. Maximum 5 URLs per request.'
                  },
                  format: {
                    type: 'string',
                    description: 'Output format for the extracted content. Options: "markdown" (default), "html", or "text".'
                  }
                },
                required: ['urls']
              }
            }
          }
        }
      }
    );

    this.setupRoutes();
    this.setupMCPHandlers();
  }

  private setupRoutes() {
    this.app.get('/health', (req, res) => {
      res.json({ status: 'healthy', timestamp: new Date().toISOString() });
    });

    // 2. Update the GET /sse handler to manage sessions
    this.app.get('/sse', (req, res) => {
      const tempTransport = new SSEServerTransport('', res);
      const sessionId = tempTransport.sessionId;

      // Now create the real transport with the unique endpoint
      const postEndpoint = `/sse/${sessionId}`;
      const transport = new SSEServerTransport(postEndpoint, res);

      // We must manually link our external transport variable to the new one
      Object.assign(transport, { _sessionId: sessionId });

      console.log(`Client connected, session created: ${transport.sessionId}`);
      console.log(`Expecting POSTs to: ${postEndpoint}`);

      // Store the transport instance using its unique session ID
      this.transports.set(transport.sessionId, transport);

      console.log(`Client connected, session created: ${transport.sessionId}`);

      // Store the transport instance using its unique session ID
      this.transports.set(transport.sessionId, transport);

      this.server.connect(transport).catch(error => {
        console.error('Failed to connect MCP server:', error);
        if (!res.writableEnded) {
          res.end();
        }
      });

      req.on('close', () => {
        console.log(`Client disconnected from SSE, cleaning up session: ${transport.sessionId}`);
        // IMPORTANT: Clean up the transport from the map when the client disconnects
        this.transports.delete(transport.sessionId);
        this.server.close().catch(console.error);
      });
    });

    // 3. Add the required POST /sse handler
    this.app.post('/sse/:sessionId', async (req, res) => {
      console.log('--- POST /sse/:sessionId request received ---');
      console.log('Headers:', JSON.stringify(req.headers, null, 2));
      console.log('Body:', JSON.stringify(req.body, null, 2));

      // The session ID is now in the URL parameters
      const { sessionId } = req.params;

      console.log(`Session ID found in URL: "${sessionId}"`);

      if (!sessionId) {
        console.error('ERROR: Session ID not found in URL.');
        return res.status(400).json({ error: 'Missing sessionId in request URL' });
      }

      const transport = this.transports.get(sessionId);

      if (!transport) {
        console.error(`ERROR: No active session found for sessionId: ${sessionId}`);
        return res.status(404).json({ error: `No active session found for sessionId: ${sessionId}` });
      }

      console.log(`SUCCESS: Found active transport for session ${sessionId}. Forwarding message.`);

      // Use the transport's built-in message handler for POST requests
      await transport.handlePostMessage(req, res, req.body);
    });

    // Your existing /tools/:toolName route is fine as an alternative API
    this.app.post('/tools/:toolName', async (req, res) => {
      try {
        const { toolName } = req.params;
        const args = req.body;

        let result;
        switch (toolName) {
          case 'google_search':
            result = await this.handleSearch({
              query: args.query,
              num_results: args.num_results,
              filters: {
                site: args.site,
                language: args.language,
                dateRestrict: args.dateRestrict,
                exactTerms: args.exactTerms,
                resultType: args.resultType,
                page: args.page,
                resultsPerPage: args.resultsPerPage,
                sort: args.sort
              }
            });
            break;

          case 'extract_webpage_content':
            result = await this.handleAnalyzeWebpage({
              url: args.url,
              format: args.format || 'markdown'
            });
            break;

          case 'extract_multiple_webpages':
            result = await this.handleBatchAnalyzeWebpages({
              urls: args.urls,
              format: args.format || 'markdown'
            });
            break;

          default:
            return res.status(404).json({ error: `Unknown tool: ${toolName}` });
        }

        res.json(result);
      } catch (error) {
        console.error('Tool execution error:', error);
        res.status(500).json({
          error: error instanceof Error ? error.message : 'Unknown error occurred'
        });
      }
    });
  }

  private setupMCPHandlers() {
    // Register tool list handler
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'google_search',
          description: 'Search Google and return relevant results from the web. This tool finds web pages, articles, and information on specific topics using Google\'s search engine. Results include titles, snippets, and URLs that can be analyzed further using extract_webpage_content.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query - be specific and use quotes for exact matches. For best results, use clear keywords and avoid very long queries.'
              },
              num_results: {
                type: 'number',
                description: 'Number of results to return (default: 5, max: 10). Increase for broader coverage, decrease for faster response.'
              },
              site: {
                type: 'string',
                description: 'Limit search results to a specific website domain (e.g., "wikipedia.org" or "nytimes.com").'
              },
              language: {
                type: 'string',
                description: 'Filter results by language using ISO 639-1 codes (e.g., "en" for English, "es" for Spanish, "fr" for French).'
              },
              dateRestrict: {
                type: 'string',
                description: 'Filter results by date using Google\'s date restriction format: "d[number]" for past days, "w[number]" for past weeks, "m[number]" for past months, or "y[number]" for past years. Example: "m6" for results from the past 6 months.'
              },
              exactTerms: {
                type: 'string',
                description: 'Search for results that contain this exact phrase. This is equivalent to putting the terms in quotes in the search query.'
              },
              resultType: {
                type: 'string',
                description: 'Specify the type of results to return. Options include "image" (or "images"), "news", and "video" (or "videos"). Default is general web results.'
              },
              page: {
                type: 'number',
                description: 'Page number for paginated results (starts at 1). Use in combination with resultsPerPage to navigate through large result sets.'
              },
              resultsPerPage: {
                type: 'number',
                description: 'Number of results to show per page (default: 5, max: 10). Controls how many results are returned for each page.'
              },
              sort: {
                type: 'string',
                description: 'Sorting method for search results. Options: "relevance" (default) or "date" (most recent first).'
              }
            },
            required: ['query']
          }
        },
        {
          name: 'extract_webpage_content',
          description: 'Extract and analyze content from a webpage, converting it to readable text. This tool fetches the main content while removing ads, navigation elements, and other clutter. Use it to get detailed information from specific pages found via google_search. Works with most common webpage formats including articles, blogs, and documentation.',
          inputSchema: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'Full URL of the webpage to extract content from (must start with http:// or https://). Ensure the URL is from a public webpage and not behind authentication.'
              },
              format: {
                type: 'string',
                description: 'Output format for the extracted content. Options: "markdown" (default), "html", or "text".'
              }
            },
            required: ['url']
          }
        },
        {
          name: 'extract_multiple_webpages',
          description: 'Extract and analyze content from multiple webpages in a single request. This tool is ideal for comparing information across different sources or gathering comprehensive information on a topic. Limited to 5 URLs per request to maintain performance.',
          inputSchema: {
            type: 'object',
            properties: {
              urls: {
                type: 'array',
                items: { type: 'string' },
                description: 'Array of webpage URLs to extract content from. Each URL must be public and start with http:// or https://. Maximum 5 URLs per request.'
              },
              format: {
                type: 'string',
                description: 'Output format for the extracted content. Options: "markdown" (default), "html", or "text".'
              }
            },
            required: ['urls']
          }
        }
      ]
    }));

    // Register tool call handler
    this.server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
      switch (request.params.name) {
        case 'google_search':
          if (typeof request.params.arguments === 'object' && request.params.arguments !== null && 'query' in request.params.arguments) {
            return this.handleSearch({
              query: String(request.params.arguments.query),
              num_results: typeof request.params.arguments.num_results === 'number' ? request.params.arguments.num_results : undefined,
              filters: {
                site: request.params.arguments.site ? String(request.params.arguments.site) : undefined,
                language: request.params.arguments.language ? String(request.params.arguments.language) : undefined,
                dateRestrict: request.params.arguments.dateRestrict ? String(request.params.arguments.dateRestrict) : undefined,
                exactTerms: request.params.arguments.exactTerms ? String(request.params.arguments.exactTerms) : undefined,
                resultType: request.params.arguments.resultType ? String(request.params.arguments.resultType) : undefined,
                page: typeof request.params.arguments.page === 'number' ? request.params.arguments.page : undefined,
                resultsPerPage: typeof request.params.arguments.resultsPerPage === 'number' ? request.params.arguments.resultsPerPage : undefined,
                sort: request.params.arguments.sort ? String(request.params.arguments.sort) : undefined
              }
            });
          }
          throw new Error('Invalid arguments for google_search tool');

        case 'extract_webpage_content':
          if (typeof request.params.arguments === 'object' && request.params.arguments !== null && 'url' in request.params.arguments) {
            return this.handleAnalyzeWebpage({
              url: String(request.params.arguments.url),
              format: request.params.arguments.format ? String(request.params.arguments.format) as OutputFormat : 'markdown'
            });
          }
          throw new Error('Invalid arguments for extract_webpage_content tool');

        case 'extract_multiple_webpages':
          if (typeof request.params.arguments === 'object' && request.params.arguments !== null && 'urls' in request.params.arguments && Array.isArray(request.params.arguments.urls)) {
            return this.handleBatchAnalyzeWebpages({
              urls: request.params.arguments.urls.map(String),
              format: request.params.arguments.format ? String(request.params.arguments.format) as OutputFormat : 'markdown'
            });
          }
          throw new Error('Invalid arguments for extract_multiple_webpages tool');

        default:
          throw new Error(`Unknown tool: ${request.params.name}`);
      }
    });
  }

  private async handleSearch(args: {
    query: string;
    num_results?: number;
    filters?: {
      site?: string;
      language?: string;
      dateRestrict?: string;
      exactTerms?: string;
      resultType?: string;
      page?: number;
      resultsPerPage?: number;
      sort?: string;
    }
  }) {
    try {
      const { results, pagination, categories } = await this.searchService.search(args.query, args.num_results, args.filters);

      if (results.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No results found. Try:\n- Using different keywords\n- Removing quotes from non-exact phrases\n- Using more general terms'
          }],
          isError: true
        };
      }

      // Format results in a more concise, readable way
      const formattedResults = results.map(result => ({
        title: result.title,
        link: result.link,
        snippet: result.snippet,
        category: result.category
      }));

      // Format results in a more AI-friendly way
      let responseText = `Search results for "${args.query}":\n\n`;

      // Add category summary if available
      if (categories && categories.length > 0) {
        responseText += "Categories: " + categories.map(c => `${c.name} (${c.count})`).join(', ') + "\n\n";
      }

      // Add pagination info
      if (pagination) {
        responseText += `Showing page ${pagination.currentPage}${pagination.totalResults ? ` of approximately ${pagination.totalResults} results` : ''}\n\n`;
      }

      // Add each result in a readable format
      formattedResults.forEach((result, index) => {
        responseText += `${index + 1}. ${result.title}\n`;
        responseText += `   URL: ${result.link}\n`;
        responseText += `   ${result.snippet}\n\n`;
      });

      // Add navigation hints if pagination exists
      if (pagination && (pagination.hasNextPage || pagination.hasPreviousPage)) {
        responseText += "Navigation: ";
        if (pagination.hasPreviousPage) {
          responseText += "Use 'page: " + (pagination.currentPage - 1) + "' for previous results. ";
        }
        if (pagination.hasNextPage) {
          responseText += "Use 'page: " + (pagination.currentPage + 1) + "' for more results.";
        }
        responseText += "\n";
      }

      return {
        content: [
          {
            type: 'text',
            text: responseText,
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error during search';
      return {
        content: [{ type: 'text', text: message }],
        isError: true
      };
    }
  }

  private async handleAnalyzeWebpage(args: { url: string; format?: OutputFormat; summarize?: boolean }) {
    try {
      const content = await this.contentExtractor.extractContent(args.url, args.format);

      // Format the response in a more readable, concise way
      let responseText = `Content from: ${content.url}\n\n`;
      responseText += `Title: ${content.title}\n`;

      if (content.description) {
        responseText += `Description: ${content.description}\n`;
      }

      responseText += `\nStats: ${content.stats.word_count} words, ${content.stats.approximate_chars} characters\n\n`;

      // Add the summary if available
      if (content.summary) {
        responseText += `Summary: ${content.summary}\n\n`;
      }

      // Add a preview of the content
      responseText += `Content Preview:\n${content.content_preview.first_500_chars}\n\n`;

      // Add a note about requesting specific information
      responseText += `Note: This is a preview of the content. For specific information, please ask about particular aspects of this webpage.`;

      return {
        content: [
          {
            type: 'text',
            text: responseText,
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      const helpText = 'Common issues:\n- Check if the URL is accessible in a browser\n- Ensure the webpage is public\n- Try again if it\'s a temporary network issue';

      return {
        content: [
          {
            type: 'text',
            text: `${errorMessage}\n\n${helpText}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async handleBatchAnalyzeWebpages(args: { urls: string[]; format?: OutputFormat }) {
    if (args.urls.length > 5) {
      return {
        content: [{
          type: 'text',
          text: 'Maximum 5 URLs allowed per request to maintain performance. Please reduce the number of URLs.'
        }],
        isError: true
      };
    }

    try {
      const results = await this.contentExtractor.batchExtractContent(args.urls, args.format);

      // Format the response in a more readable, concise way
      let responseText = `Content from ${args.urls.length} webpages:\n\n`;

      for (const [url, result] of Object.entries(results)) {
        responseText += `URL: ${url}\n`;

        if ('error' in result) {
          responseText += `Error: ${result.error}\n\n`;
          continue;
        }

        responseText += `Title: ${result.title}\n`;

        if (result.description) {
          responseText += `Description: ${result.description}\n`;
        }

        responseText += `Stats: ${result.stats.word_count} words\n`;

        // Add summary if available
        if (result.summary) {
          responseText += `Summary: ${result.summary}\n`;
        }

        responseText += `Preview: ${result.content_preview.first_500_chars.substring(0, 150)}...\n\n`;
      }

      responseText += `Note: These are previews of the content. To analyze the full content of a specific URL, use the extract_webpage_content tool with that URL.`;

      return {
        content: [
          {
            type: 'text',
            text: responseText,
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      const helpText = 'Common issues:\n- Check if all URLs are accessible in a browser\n- Ensure all webpages are public\n- Try again if it\'s a temporary network issue\n- Consider reducing the number of URLs';

      return {
        content: [
          {
            type: 'text',
            text: `${errorMessage}\n\n${helpText}`,
          },
        ],
        isError: true,
      };
    }
  }

  async start() {
    try {
      this.app.listen(this.port, () => {
        console.log(`Google Search MCP server running on port ${this.port}`);
        console.log(`SSE endpoint: http://localhost:${this.port}/sse`);
        console.log(`Health check: http://localhost:${this.port}/health`);
        console.log(`Direct API: http://localhost:${this.port}/tools/{toolName}`);
      });

      // Graceful shutdown
      process.on('SIGINT', () => {
        console.log('\nGracefully shutting down...');
        this.server.close().catch(console.error);
        process.exit(0);
      });
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error('Failed to start MCP server:', error.message);
      } else {
        console.error('Failed to start MCP server: Unknown error');
      }
      process.exit(1);
    }
  }
}

// Start the server
const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const server = new GoogleSearchServer(port);
server.start().catch(console.error);