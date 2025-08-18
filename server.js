// server.js - Main Node.js server
const express = require('express');
const WebSocket = require('ws');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { Translate } = require('@google-cloud/translate').v2;
const OpenAI = require('openai');

const app = express();
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

// Initialize APIs
const translate = new Translate({
  projectId: process.env.GOOGLE_PROJECT_ID,
  key: process.env.GOOGLE_API_KEY
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Configure multer for audio file uploads
const upload = multer({
  dest: 'uploads/',
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/webm'];
    cb(null, allowedTypes.includes(file.mimetype));
  },
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB limit
});

app.use(express.static('public'));
app.use(express.json());

// Language configurations
const LANGUAGES = {
  'en': 'English',
  'it': 'Italian',
  'zh': 'Chinese'
};

const TARGET_LANGUAGES = ['it', 'zh']; // Always translate to Italian and Chinese

// WebSocket connection handling
wss.on('connection', (ws) => {
  console.log('Client connected');
  
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'audio_chunk') {
        await handleAudioChunk(ws, data);
      }
    } catch (error) {
      console.error('WebSocket error:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Failed to process audio chunk'
      }));
    }
  });
  
  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

// Handle audio chunk processing
async function handleAudioChunk(ws, data) {
  try {
    // Save audio chunk to temporary file
    const audioBuffer = Buffer.from(data.audio, 'base64');
    const tempFilePath = path.join(__dirname, 'uploads', `chunk_${Date.now()}.wav`);
    
    fs.writeFileSync(tempFilePath, audioBuffer);
    
    // Transcribe with Whisper
    const transcription = await transcribeAudio(tempFilePath, data.sourceLanguage);
    
    if (transcription && transcription.trim()) {
      // Translate to target languages
      const translations = await translateText(transcription, data.sourceLanguage);
      
      // Send results back to client
      ws.send(JSON.stringify({
        type: 'translation_result',
        timestamp: new Date().toISOString(),
        sourceLanguage: data.sourceLanguage,
        sourceText: transcription,
        translations: translations
      }));
    }
    
    // Clean up temporary file
    fs.unlinkSync(tempFilePath);
    
  } catch (error) {
    console.error('Audio processing error:', error);
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Failed to process audio'
    }));
  }
}

// Transcribe audio using OpenAI Whisper
async function transcribeAudio(filePath, language) {
  try {
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: 'whisper-1',
      language: language === 'zh' ? 'zh' : language, // Whisper uses 'zh' for Chinese
      response_format: 'text'
    });
    
    return transcription;
  } catch (error) {
    console.error('Transcription error:', error);
    throw error;
  }
}

// Translate text to target languages
async function translateText(text, sourceLanguage) {
  const translations = {};
  
  for (const targetLang of TARGET_LANGUAGES) {
    if (targetLang !== sourceLanguage) {
      try {
        const [translation] = await translate.translate(text, {
          from: sourceLanguage,
          to: targetLang
        });
        
        translations[targetLang] = translation;
      } catch (error) {
        console.error(`Translation error for ${targetLang}:`, error);
        translations[targetLang] = `[Translation Error]`;
      }
    } else {
      translations[targetLang] = text; // Same language, no translation needed
    }
  }
  
  return translations;
}

// REST endpoint for file upload (alternative to real-time)
app.post('/upload-audio', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }
    
    const sourceLanguage = req.body.sourceLanguage || 'en';
    const transcription = await transcribeAudio(req.file.path, sourceLanguage);
    
    if (transcription && transcription.trim()) {
      const translations = await translateText(transcription, sourceLanguage);
      
      res.json({
        sourceLanguage,
        sourceText: transcription,
        translations
      });
    } else {
      res.json({
        error: 'No speech detected'
      });
    }
    
    // Clean up uploaded file
    fs.unlinkSync(req.file.path);
    
  } catch (error) {
    console.error('Upload processing error:', error);
    res.status(500).json({ error: 'Failed to process audio file' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} to use the app`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});