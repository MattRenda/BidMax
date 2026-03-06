import Anthropic from '@anthropic-ai/sdk';
import fetch from 'node-fetch';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function analyzeLot(req, res) {
  const { description, imageUrl, settings } = req.body;

  if (!description || description.trim().length < 3) {
    return res.status(400).json({ error: 'Please provide a lot description.' });
  }

  const {
    targetMargin = 30,
    buyersPremium = 15,
    fbFee = 5,
    effortCost = 10,
  } = settings || {};

  try {
    const content = [];

    // If image URL provided (from Chrome extension), fetch and include it
    if (imageUrl) {
      try {
        const imgRes = await fetch(imageUrl);
        const arrayBuffer = await imgRes.arrayBuffer();
        const base64 = Buffer.from(arrayBuffer).toString('base64');
        const mediaType = imgRes.headers.get('content-type') || 'image/jpeg';
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: base64 },
        });
      } catch (imgErr) {
        console.warn('Could not fetch image:', imgErr.message);
      }
    }

    content.push({
      type: 'text',
      text: `You are an expert reseller who knows Facebook Marketplace prices very well.

Analyze this auction lot and return ONLY a valid JSON object with no markdown, no explanation, just raw JSON.

Lot info:
"${description}"

Return this exact JSON structure:
{
  "lotTitle": "short title for this lot",
  "items": [
    {
      "name": "item name",
      "condition": "new|like new|good|fair|poor",
      "estimatedValue": 25,
      "confidence": "high|medium|low",
      "notes": "brief note about FB Marketplace value"
    }
  ],
  "totalEstimatedValue": 100,
  "lotNotes": "any important notes about the lot overall"
}

Rules:
- estimatedValue = realistic FB Marketplace local price (NOT eBay, NOT retail)
- FB Marketplace prices are typically 40-60% of retail — be conservative
- If condition is unclear, assume fair/poor
- Group very small misc items together
- totalEstimatedValue is the sum of all items
- If an image is provided, use it to assess condition and identify items`,
    });

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content }],
    });

    let parsed;
    try {
      const text = message.content[0].text.trim();
      parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch {
      return res.status(500).json({ error: 'Failed to parse response. Try again.' });
    }

    const total = parsed.totalEstimatedValue || 0;
    const fbFeeAmount = total * (fbFee / 100);
    const targetProfitAmount = total * (targetMargin / 100);
    const preBidAmount = total - fbFeeAmount - targetProfitAmount - effortCost;
    const maxBid = Math.max(0, Math.floor(preBidAmount / (1 + buyersPremium / 100)));

    return res.json({
      ...parsed,
      breakdown: {
        estimatedSaleValue: total,
        fbFee: Math.round(fbFeeAmount),
        targetProfit: Math.round(targetProfitAmount),
        effortCost,
        buyersPremium: `${buyersPremium}%`,
        maxBid,
        expectedProfit: Math.round(total - (maxBid * (1 + buyersPremium / 100)) - fbFeeAmount - effortCost),
      },
    });

  } catch (err) {
    console.error('Analyze error:', err);
    return res.status(500).json({ error: err.message || 'Analysis failed.' });
  }
}
