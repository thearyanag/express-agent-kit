import express from 'express';
import cors from 'cors';
import { SolanaAgentKit, createSolanaTools } from "solana-agent-kit";
import { HumanMessage, BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import * as dotenv from "dotenv";
import type { Request, Response } from 'express';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Validate environment variables
function validateEnvironment(): void {
    const missingVars: string[] = [];
    const requiredVars = ["OPENAI_API_KEY", "RPC_URL", "SOLANA_PRIVATE_KEY"];

    requiredVars.forEach((varName) => {
        if (!process.env[varName]) {
            missingVars.push(varName);
        }
    });

    if (missingVars.length > 0) {
        console.error("Error: Required environment variables are not set");
        missingVars.forEach((varName) => {
            console.error(`${varName}=your_${varName.toLowerCase()}_here`);
        });
        process.exit(1);
    }
}

validateEnvironment();

// Initialize agent (moved outside to be reusable)
let agent: any;
let config: any;
let messageHistory: BaseMessage[] = [];  // Store message history

async function initializeAgent() {
    try {
        const llm = new ChatOpenAI({
            modelName: "gpt-4o-mini",
            temperature: 0.3,
        });

        const solanaAgent = new SolanaAgentKit(
            process.env.SOLANA_PRIVATE_KEY!,
            process.env.RPC_URL!,
            {
                OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
            },
        );

        const tools = createSolanaTools(solanaAgent);
        const memory = new MemorySaver();
        
        return {
            agent: createReactAgent({
                llm,
                tools,
                checkpointSaver: memory,
                messageModifier: `
                You are a helpful agent that can interact onchain using the Solana Agent Kit. You are
                empowered to interact onchain using your tools. If you ever need funds, you can request them from the
                faucet. If not, you can provide your wallet details and request funds from the user. If there is a 5XX
                (internal) HTTP error code, ask the user to try again later. If someone asks you to do something you
                can't do with your currently available tools, you must say so, and encourage them to implement it
                themselves using the Solana Agent Kit, recommend they go to https://www.solanaagentkit.xyz for more information. Be
                concise and helpful with your responses. Refrain from restating your tools' descriptions unless it is explicitly requested.
                `,
            }),
            config: { configurable: { thread_id: "Solana Agent Kit!" } }
        };
    } catch (error) {
        console.error("Failed to initialize agent:", error);
        throw error;
    }
}

// API Routes
app.post('/api/chat', async (req: any, res: any) => {
    try {
        const { message } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        if (!agent) {
            const initialized = await initializeAgent();
            agent = initialized.agent;
            config = initialized.config;
        }

        // Add the new message to history
        const newMessage = new HumanMessage(message);
        messageHistory.push(newMessage);

        const stream = await agent.stream(
            { messages: messageHistory },  // Pass the full message history
            config,
        );

        const responses: string[] = [];
        for await (const chunk of stream) {
            if ("agent" in chunk) {
                const response = String(chunk.agent.messages[0].content);
                responses.push(response);
                // Add the agent's response to history
                messageHistory.push(chunk.agent.messages[0]);
            } else if ("tools" in chunk) {
                console.log(chunk.tools.messages[0].content);
            }
        }

        res.json({ response : responses.join('') });
    } catch (error) {
        console.error('Error processing chat:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Health check endpoint
app.get('/api/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
