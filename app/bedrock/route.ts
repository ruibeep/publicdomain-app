import { NextRequest, NextResponse } from 'next/server';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

export async function GET(request: NextRequest) {
  try {
    const client = new BedrockRuntimeClient({
      region: process.env.AWS_REGION,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
    });

    const prompt = 'Explain Bedrock AI in simple terms.';

    const payload = {
      prompt,
      max_tokens: 1000,
      temperature: 0.7,
    };

    const command = new InvokeModelCommand({
      modelId: 'mistral.mistral-large-2402-v1:0',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(payload),
    });

    const response = await client.send(command);
    const responseBody = new TextDecoder().decode(response.body);
    const parsed = JSON.parse(responseBody);

    return NextResponse.json({
      prompt,
      response: parsed.outputs?.[0]?.text || 'No response',
    });
  } catch (error) {
    console.error('[Bedrock Mistral Error]', error);
    return NextResponse.json({ error: 'Failed to invoke Mistral' }, { status: 500 });
  }
}