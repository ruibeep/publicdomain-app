import bcrypt from 'bcrypt';
import { db } from '@vercel/postgres';
import { authors, books, quotes } from '../lib/publicdomainlibrary-data';

const client = await db.connect();

async function seedAuthors() {

  await client.sql`
    CREATE TABLE IF NOT EXISTS authors (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      image TEXT,
      born DATE CHECK (born <= CURRENT_DATE), -- Ensures 'born' is not in the future
      death DATE CHECK (death IS NULL OR death >= born), -- Ensures 'death' is after 'born'
      description TEXT,
      link TEXT
    );
  `;
  
  const insertedAuthors = await Promise.all(
    authors.map(async (author: { name: string | number | boolean | null | undefined; image: string | number | boolean | null | undefined; birth: string | number | boolean | null | undefined; death: string | number | boolean | null | undefined; description: string | number | boolean | null | undefined; link: string | number | boolean | null | undefined; }) => {
      return client.sql`
        INSERT INTO authors (name, image, born, death, description, link)
        VALUES (${author.name}, ${author.image}, ${author.birth}, ${author.death},${author.description},${author.link})
        ON CONFLICT (name)
        DO UPDATE SET
          image = EXCLUDED.image,
          born = EXCLUDED.born,
          death = EXCLUDED.death,
          description = EXCLUDED.description,
          link = EXCLUDED.link;        
            `;
    }),
  );

  return insertedAuthors; 
}

async function seedBooks() {
  await client.sql`
    CREATE TABLE IF NOT EXISTS books (
      id SERIAL PRIMARY KEY,
      cover TEXT,
      title TEXT NOT NULL UNIQUE,
      files TEXT,
      language TEXT,
      link TEXT,
      author_id INT NOT NULL,
      FOREIGN KEY (author_id) REFERENCES authors(id) ON DELETE CASCADE
    );
  `;

  const insertedBoooks = await Promise.all(
    books.map(async (book) => {
      return client.sql`
        INSERT INTO books (cover, title, files, language, link, author_id)
        VALUES (${book.cover}, ${book.title}, ${book.files}, ${book.language},${book.link},${book.author_id})

        ON CONFLICT (title)
        DO UPDATE SET
          cover = EXCLUDED.cover,
          files = EXCLUDED.files,
          language = EXCLUDED.language,
          link = EXCLUDED.link,
          author_id = EXCLUDED.author_id;
            `;
    }),
  );

  return insertedBoooks; 
}

async function seedQuotes() {
  await client.sql`
    CREATE TABLE IF NOT EXISTS quotes (
      id SERIAL PRIMARY KEY,
      quote TEXT NOT NULL UNIQUE,
      popularity INT,
      book_id INT NOT NULL,
      size INT GENERATED ALWAYS AS (length(quote)) STORED,
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
    );
  `;

  const insertedQuotes = await Promise.all(
    quotes.map(async (quote) => {
      return client.sql`
        INSERT INTO quotes (quote, popularity, book_id)
        VALUES (${quote.quote}, ${quote.popularity}, ${quote.book_id})

        ON CONFLICT (quote)
        DO UPDATE SET
          popularity = EXCLUDED.popularity;
            `;
    }),
  );

  return insertedQuotes; 
}

async function seedPosts() {

  await client.sql`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'post_status') THEN
          CREATE TYPE post_status AS ENUM (
            'private',
            'published',
            'scheduled',
            'deleted'
          );
      END IF;
    END $$;
  `;
  await client.sql`
    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      author_id INT,
      book_id INT,
      quote_id INT,
      creation_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      published_date TIMESTAMPTZ,
      status post_status NOT NULL DEFAULT 'private',
      text TEXT,
      image_link TEXT,
      platform TEXT,
      FOREIGN KEY (author_id) REFERENCES authors(id) ON DELETE SET NULL,
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE SET NULL,
      FOREIGN KEY (quote_id) REFERENCES quotes(id) ON DELETE SET NULL
    );
  `;

  return client.sql`
        INSERT INTO posts (quote_id, text, image_link, platform, status)
        VALUES (
          1,
          'Check out this inspiring quote!',
          'https://example.com/images/mark-twain-quote.jpg',
          'X',
          'scheduled'
        );
      `;
}

export async function GET() {
  try {
    await client.sql`BEGIN`;
    await seedAuthors();
    // await seedBooks();
    // await seedQuotes();
    // await seedPosts();
    await client.sql`COMMIT`;

    return Response.json({ message: 'seedPosts: Database seeded successfully' });
  } catch (error) {
    await client.sql`ROLLBACK`;
    return Response.json({ error }, { status: 500 });
  }
}