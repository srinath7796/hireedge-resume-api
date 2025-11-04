// pages/api/generate-template.js
// -------------------------------------------------------------
// HireEdge — AI CV TEMPLATE Generator API
//
// What this does:
// 1. Accepts POST from your Shopify section (industry, style, complexity...)
// 2. (Optional) Calls OpenAI to build a CV template text tailored to UK jobs
// 3. Returns JSON { ok: true, template: "..." }
// 4. Uses same CORS pattern as your generate-resume.js
//
// Frontend you built will call this and show the template in a <pre> box.
// -------------------------------------------------------------

import OpenAI from "openai";

// Allow only your Shopify domain to call this
// change this if your live domain is different
const ALLOWED_ORIGIN = "https://hireedge.co.uk";

// simple helper: always return trimmed string
const S = (v) => (v ?? "").toString().trim();

// create OpenAI client only if key exists (same pattern as your resume API)
function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

export default async function handler(req, res) {
  // --------------------------
  // 1) CORS (same as your other API)
  // --------------------------
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  // preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // health check (useful for browser test)
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      message: "HireEdge AI Template API alive ✅",
    });
  }

  // only accept POST for generation
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // --------------------------------------------------
    // 2) Read and normalise body
    // --------------------------------------------------
    const body =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    // these are sent from Shopify section
    const industry = S(body.industry); // required
    const style = S(body.style) || "Modern"; // e.g. Modern / Classic / Creative
    const complexity = S(body.complexity) || "Moderate"; // Simple / Moderate / Detailed
    const colors = S(body.colors); // optional styling notes
    const notes = S(body.notes); // optional extra requirements

    if (!industry) {
      // we need at least an industry / role to tailor the template
      return res.status(400).json({
        error: "Missing field: industry",
      });
    }

    // --------------------------------------------------
    // 3) Prepare prompt for OpenAI
    // --------------------------------------------------
    const client = getOpenAIClient();

    const prompt = `
You are a UK CV designer working for a CV/Resume builder called HireEdge.

Your task: create a **CV TEMPLATE** (not a finished CV) for a candidate in this industry/role: "${industry}".

User preferences:
- Visual style: ${style}
- Complexity / length: ${complexity}
- Color / design preferences: ${colors || "none provided"}
- Extra requirements from user: ${notes || "none"}

Important rules:
1. This is for the UK job market.
2. Output must be structured, with numbered sections.
3. Include short guidance under each section (1 or 2 lines) or sample bullets.
4. If complexity is "Detailed", include optional sections (Certifications, Projects, Volunteering, Languages).
5. Do NOT add explanations before or after — return ONLY the template.

Target format example:

1. Header
   - Full name
   - Target job title (aligned to ${industry})
   - Location (City, UK) | Phone | Email | LinkedIn

2. Professional Summary
   - 3–4 lines tailored to ${industry}, mentioning years of experience, domain knowledge, and key strengths

3. Key Skills
   - Bullet or inline list of 6–10 skills that match ${industry}

4. Professional Experience
   - Job Title | Employer | Location | Dates
   - 3–5 bullet points focused on achievements, KPIs, tools, or responsibilities relevant to ${industry}
   - Repeat for previous roles (reverse chronological)

5. Education
   - Degree / Qualification, Institution, Year
   - Include UK-recognised courses if relevant

6. Certifications / Training (optional)
   - Certification name — Provider — Year

7. Additional sections (pick ONLY if relevant to ${industry})
   - Projects
   - Volunteering
   - Publications
   - Languages

Now create the final template for "${industry}" with style "${style}" and complexity "${complexity}".
`;

    // --------------------------------------------------
    // 4) Call OpenAI (or fallback if no key)
    // --------------------------------------------------
    let templateText = "";

    if (!client) {
      // no API key — return a sensible default so your frontend still works
      templateText = `CV Template for ${industry} (${style}, ${complexity})

1. Header
   - Full name
   - Target title (e.g. ${industry})
   - Location (City, UK) | Phone | Email | LinkedIn

2. Professional Summary
   - 3–4 lines highlighting years of experience, domain/industry knowledge, and key outcomes
   - Mention customer focus / stakeholder management if relevant

3. Key Skills
   - 6–10 skills related to ${industry}
   - Example: Communication, MS Office / CRM, Customer Service, Problem Solving, Teamwork, Time Management

4. Professional Experience
   - Job Title | Company | Location | Dates
   - 3–5 bullets showing impact (improved processes, supported customers, used specific tools)
   - Repeat for previous roles (most recent first)

5. Education
   - Degree / Diploma / NVQ, Institution, Year
   - Add UK-specific or industry training if you have it

6. Certifications / Training (optional)
   - Course / Certification — Provider — Year

7. Additional Sections (optional based on role)
   - Projects
   - Volunteering
   - Languages
   - Achievements

Notes:
- Adjust the order to put "Skills" higher if the role is junior or career-change.
- Keep to 1–2 pages unless it's a senior role.`;
    } else {
      const resp = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.4, // a bit controlled so template is tidy
      });

      templateText = resp.choices[0].message.content.trim();
    }

    // --------------------------------------------------
    // 5) Return JSON to Shopify
    // --------------------------------------------------
    return res.status(200).json({
      ok: true,
      template: templateText,
    });
  } catch (err) {
    // any unexpected error
    console.error("❌ AI template generation failed:", err);
    return res.status(500).json({
      error: "AI template generation failed",
      details: String(err),
    });
  }
}
