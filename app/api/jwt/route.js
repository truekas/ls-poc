import { main } from '@/oauth-poc';
export const runtime = 'nodejs';

export async function POST(req) {
  return new Promise(async (resolve) => {
    const data = await req.json();
    const jwt = await main(data.email, data.cId);
    resolve(new Response(jwt, { status: 200 }))

  });
}
