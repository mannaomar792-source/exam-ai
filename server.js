
import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import OpenAI from 'openai';

const app = express();
const port = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(process.cwd(), 'public')));

async function pdfText(buffer) {
  const mod = await import('pdf-parse');
  const parse = mod.default || mod;
  const result = await parse(buffer);
  return (result.text || '').replace(/\s+/g, ' ').trim();
}

function parseJson(s) {
  return JSON.parse(String(s).replace(/```json|```/g, '').trim());
}

app.post('/api/analyze-book', upload.single('book'), async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({error:'ضع OPENAI_API_KEY على الخادم أولًا.'});
    if (!req.file) return res.status(400).json({error:'ارفع ملف PDF أولًا.'});
    if (!req.file.originalname.toLowerCase().endsWith('.pdf')) return res.status(400).json({error:'الملف يجب أن يكون PDF.'});

    const text = await pdfText(req.file.buffer);
    if (text.length < 700) return res.status(400).json({error:'لم يتم استخراج نص كافٍ من PDF. إذا كان الكتاب صورًا، يحتاج OCR.'});

    const source = text.slice(0, 300000);
    const prompt = `
أنت محلل كتب مدرسية. استخرج هيكل الكتاب إلى وحدات ودروس، ولا تخترع أي عنوان غير موجود.
أعد JSON فقط بهذا الشكل:
{
  "units":[
    {
      "id":"u1",
      "title":"اسم الوحدة",
      "lessons":[
        {"id":"u1l1","title":"اسم الدرس"},
        {"id":"u1l2","title":"اسم الدرس"}
      ]
    }
  ]
}
استعمل عناوين الكتاب قدر الإمكان، وإذا وجدت وحدة بلا دروس واضحة اجعل lessons مصفوفة فارغة.
الكتاب:
${source}`;
    const r = await client.responses.create({
      model: 'gpt-5.6-luna',
      input: prompt,
      text: {format:{type:'json_object'}}
    });
    res.json({bookText: source, ...(parseJson(r.output_text))});
  } catch (e) {
    console.error(e);
    res.status(500).json({error:e.message || 'حدث خطأ أثناء تحليل الكتاب.'});
  }
});

app.post('/api/generate-exam', async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({error:'ضع OPENAI_API_KEY على الخادم أولًا.'});
    const {bookText, unitTitle, lessonTitle, level='medium', count=10, type='mcq'} = req.body || {};
    if (!bookText) return res.status(400).json({error:'محتوى الكتاب غير موجود.'});

    const n = Math.max(1, Math.min(50, Number(count) || 10));
    const levelText = {easy:'سهل ومباشر',medium:'متوسط ويتطلب فهمًا',hard:'صعب ويتطلب ربطًا واستنتاجًا'}[level] || 'متوسط';
    const typeText = type==='mixed' ? 'مختلط بين MCQ وصح/خطأ' : type==='tf' ? 'صح/خطأ فقط' : 'اختيار من متعدد فقط';

    let scope;
    if (lessonTitle && lessonTitle !== '__ALL_LESSONS__') {
      scope = `النطاق المطلوب: الوحدة "${unitTitle}"، الدرس "${lessonTitle}" فقط.`;
    } else if (unitTitle && unitTitle !== '__ALL_UNITS__') {
      scope = `النطاق المطلوب: الوحدة "${unitTitle}" كاملة، أي جميع دروسها.`;
    } else {
      scope = `النطاق المطلوب: الكتاب كاملًا.`;
    }

    const prompt = `
أنت مولد امتحانات مدرسية احترافي.
${scope}
المستوى: ${levelText}
عدد الأسئلة: ${n}
نوع الأسئلة: ${typeText}

شروط:
- استخدم محتوى النطاق المحدد فقط من الكتاب.
- لا تعتمد على معلومات خارج الكتاب.
- لا تكرر الأفكار.
- MCQ = 4 خيارات وإجابة واحدة صحيحة.
- True/False = خيار صح أو خطأ.
- أضف شرحًا قصيرًا جدًا للإجابة من محتوى الكتاب.
- JSON فقط:
{
 "title":"...",
 "questions":[
  {"number":1,"type":"mcq","question":"...","options":["...","...","..."],"answer":"...","explanation":"..."}
 ]
}
محتوى الكتاب:
${bookText.slice(0,300000)}
`;
    const r = await client.responses.create({
      model: 'gpt-5.6-luna',
      input: prompt,
      text: {format:{type:'json_object'}}
    });
    res.json(parseJson(r.output_text));
  } catch(e) {
    console.error(e);
    res.status(500).json({error:e.message || 'تعذر إنشاء الامتحان.'});
  }
});

app.listen(port,()=>console.log(`Exam AI on http://localhost:${port}`));
