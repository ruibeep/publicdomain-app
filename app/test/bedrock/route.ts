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

    const systemPrompt = 'You are PD-Book-Bot. Rules: Recommend ONLY titles that appear between <<BOOK_LIST_START>> and <<BOOK_LIST_END>> in the user prompt.; Rank them by overall_score (0-5) that YOU assign for fit to the OP request.; hook should be 100 characters or less;Return at most 3 books in valid JSON like: [{"overall_score":4.2, "title":"Dracula","hook":"A solicitor visits a Transylvanian count with a dark secret."}]; If none score ≥ 3.4, reply with [] (empty JSON array). No extra text.';

    const userPrompt = '<<BOOK_LIST_START>> Sense and Sensibility The Hound of the Baskervilles The Time Machine The Great Gatsby Pride & Prejudice Romeo and Juliet Little Women Jane Eyre Wuthering Heights Frankenstein The Picture of Dorian Gray The Adventures of Huckleberry Finn Dracula The Odyssey Anne of Green Gables A Tale of Two Cities The Count of Monte Cristo Crime and Punishment Emma Anna Karenina Les Misérables Alice\'s Adventures in Wonderland Moby-Dick The Art of War The Wonderful Wizard of Oz The Iliad The Adventures of Sherlock Holmes The Call of the Wild Peter Pan Meditations The Strange Case of Dr Jekyll and Mr Hyde Le Morte d\'Arthur The Autobiography of Benjamin Franklin Middlemarch A Room with a View The Blue Castle The Enchanted April Cranford History of Tom Jones, a Foundling Twenty years after A Doll\'s House A Christmas Carol The Scarlet Letter Gulliver\'s Travels The Importance of Being Earnest Great Expectations Women and Economics The Brothers Karamazov Don Quijote In Search of Lost Time Thus Spake Zarathustra Leviathan War and Peace Household Tales The Prince Heart of Darkness The Souls of Black Folk Winnie-the-Pooh Walden Dialogues Second Treatise of Government Beowulf: An Anglo-Saxon Epic Poem The Adventures of Tom Sawyer Tractatus Logico-Philosophicus Dubliners The divine comedy Bambi In a Glass Darkly Narrative of the Life of Frederick Douglass The Sketch-Book of Geoffrey Crayon, Gent. The War of the Worlds Fables Poetry Nicomachean Ethics The King in Yellow Candide The Interesting Narrative of the Life of Olaudah Equiano Incidents in the Life of a Slave Girl On Liberty Ethan Frome The Life and Adventures of Robinson Crusoe The History of the Peloponnesian War Paradise Lost The Wealth of Nations The Secret Garden The Origin of Species Madame Bovary The Turn of the Screw Philosophical Works The Awakening Flatland The House of Mirth The Last of the Mohicans The Story Of My Experiments With Truth The Communist Manifesto Noli Me Tangere <<BOOK_LIST_END>> ### OP_REQUEST Book suggestions to gift a friend on his graduation? Hello there, my friend will be graduating from medical school soon and I\'m trying to find a few good books to gift him. He enjoys high-fantasy, crime thrillers and self help/motivational non-fiction reads. We\'ve been friends for a long time, and I really want to choose something that he will enjoy and remember me by, but \'m overwhelmed by all the choices and could really use some help narrowing it down. If you need more insight to help recommend a book, please feel free to ask. Thank you in advance :) !### END_OP_REQUEST';


    const payload = {
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 500,
      temperature: 0.2,
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
    const content = parsed.choices[0]?.message.content || 'No response';

    /*
    payload,
    response: parsed.outputs?.[0]?.text || 'No response',
    */
    return NextResponse.json({
      // parsed,
      response: JSON.parse(content),
    });
  } catch (error) {
    console.error('[Bedrock Mistral Error]', error);
    return NextResponse.json({ error: 'Failed to invoke Mistral' }, { status: 500 });
  }
}