// server.js - Main Node.js server
require('dotenv').config();

const express = require('express');
const WebSocket = require('ws');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const https = require('https');
const OpenAI = require('openai');

const app = express();
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

// Initialize APIs
if (!process.env.GOOGLE_API_KEY) {
  throw new Error('GOOGLE_API_KEY environment variable is required');
}

if (!process.env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY environment variable is required');
}

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
const SUPPORTED_LANGUAGES = ['en', 'it', 'zh', 'zh-cn', 'zh-CN', 'zh-tw', 'zh-TW']; // Include all Chinese variants and case variations
const LANGUAGES = {
  'en': 'English',
  'it': 'Italian', 
  'zh': 'Chinese',
  'zh-cn': 'Chinese',
  'zh-CN': 'Chinese',
  'zh-tw': 'Chinese',
  'zh-TW': 'Chinese'
};

const TARGET_LANGUAGES = ['it', 'zh', 'en']; // Always translate to Italian, Chinese, and English

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
    
    // Transcribe with Whisper (auto-detect language by omitting language parameter)
    const transcription = await transcribeAudio(tempFilePath, data.sourceLanguage);
    
    if (transcription && transcription.trim()) {
      // Translate to target languages (auto-detect source language)
      const result = await translateText(transcription, 'auto');
      
      // Only send results if language is supported
      if (result && result.detectedLanguage) {
        ws.send(JSON.stringify({
          type: 'translation_result',
          timestamp: new Date().toISOString(),
          sourceLanguage: result.detectedLanguage,
          sourceText: transcription,
          translations: result.translations
        }));
      } else {
        console.log('Unsupported language detected or translation failed. Ignoring transcription.');
      }
    } else {
      // Don't send anything if transcription is invalid or empty
      console.log('No valid speech detected in audio chunk');
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
    const transcriptionParams = {
      file: fs.createReadStream(filePath),
      model: 'whisper-1',
      response_format: 'text'
    };
    
    // Only add language parameter if it's not 'auto'
    if (language && language !== 'auto') {
      transcriptionParams.language = language === 'zh' ? 'zh' : language;
    }
    // If language is 'auto' or not specified, Whisper will auto-detect
    
    const transcription = await openai.audio.transcriptions.create(transcriptionParams);
    
    // Filter out Whisper hallucinations and false transcriptions
    if (isValidTranscription(transcription)) {
      return transcription;
    } else {
      console.log('Filtered out invalid transcription:', transcription);
      return null; // Return null for invalid transcriptions
    }
    
  } catch (error) {
    console.error('Transcription error:', error);
    throw error;
  }
}

// Check if transcription is valid (not a Whisper hallucination)
function isValidTranscription(text) {
  if (!text || typeof text !== 'string') {
    return false;
  }
  
  const cleanText = text.trim().toLowerCase();
  
  // Filter out empty or very short transcriptions
  if (cleanText.length < 2) {
    console.log('Text too short:', cleanText);
    return false;
  }
  
  // Check if text contains characters from supported languages
  const hasEnglish = /[a-zA-Z]/.test(cleanText);
  const hasItalian = /[a-zA-ZàáâäèéêëìíîïòóôöùúûüÀÁÂÄÈÉÊËÌÍÎÏÒÓÔÖÙÚÛÜ]/.test(cleanText);
  const hasChinese = /[\u4e00-\u9fff]/.test(cleanText);
  
  // Check for Japanese characters (to reject)
  const hasJapanese = /[\u3040-\u309f\u30a0-\u30ff]/.test(cleanText);
  if (hasJapanese) {
    console.log('Japanese characters detected. Rejecting:', cleanText);
    return false;
  }
  
  // Must contain characters from at least one supported language
  if (!hasEnglish && !hasItalian && !hasChinese) {
    console.log('Text does not contain supported language characters:', cleanText);
    return false;
  }
  
  // Simplified hallucination patterns - focus on the most problematic ones
  const hallucination_patterns = [
    // Single word hallucinations that are very common
    /^bye$/i,
    /^beep$/i,
    /^okay$/i,
    /^ok$/i,
    /^hi$/i,
    /^hello$/i,
    /^yeah$/i,
    /^yes$/i,
    /^no$/i,
    /^um$/i,
    /^uh$/i,
    /^oh$/i,
    /^ah$/i,
    
    // Common two-word hallucinations
    /^okay bye$/i,
    /^bye bye$/i,
    /^thank you$/i,
    /^you know$/i,
    /^i mean$/i,
    /^right now$/i,
    /^of course$/i,
    
    // Video/promotional content (the main culprits) - EXPANDED with your examples
    /if you enjoyed.*subscribe/i,
    /please subscribe and like/i,
    /thank you for watching/i,
    /thanks for watching/i,
    /thank you for listening/i,
    /thanks for listening/i,
    /share this video/i,
    /subscribe/i,
    /like and subscribe/i,
    /don't forget to/i,
    /visit our website/i,
    /follow us/i,
    /check out/i,
    /click the link/i,
    /smash that like button/i,
    /ring the bell/i,
    
    // Your specific examples - ending phrases
    /that's it for this video/i,
    /hope you enjoyed it/i,
    /see you in the next one/i,
    /i'll see you in the next/i,
    /if you have any questions or comments/i,
    /please post them in the comments/i,
    /post them in the comments section/i,
    /leave a comment below/i,
    /let me know in the comments/i,
    
    // More video ending patterns
    /that's all for today/i,
    /that's all for now/i,
    /until next time/i,
    /see you next time/i,
    /catch you later/i,
    /stay tuned/i,
    /coming up next/i,
    /thanks for tuning in/i,
    /thanks for joining/i,
    /hope to see you/i,
    /don't forget to hit/i,
    /make sure to hit/i,
    
    // Technical artifacts
    /\d{1,2}:\d{2}/,  // Time patterns like "1:23"
    /\[.*\]/,         // Text in brackets
    /\(music\)/i,
    /\[music\]/i,
    
    // Social media artifacts
    /📢|🎵|♪|📱|💡|🔔|👍|❤️|💯/,  // Emojis
    /www\./i,
    /\.com/i,
    /http/i,
    /@\w+/,           // @ mentions
    /#\w+/,           // hashtags
    
    // Caption artifacts
    /caption/i,
    /subtitle/i,
    /closed caption/i,
    
    // Repetitive patterns (actual noise)
    /(.)\1{4,}/,  // Same character repeated 5+ times
  ];
  
  // Check against hallucination patterns
  for (const pattern of hallucination_patterns) {
    if (pattern.test(cleanText)) {
      console.log('Filtered hallucination pattern:', cleanText);
      return false;
    }
  }
  
  // Very basic quality check - mostly letters/characters
  const letterCount = (cleanText.match(/[a-zA-Z\u00C0-\u017F\u4e00-\u9fff]/g) || []).length;
  const totalLength = cleanText.length;
  
  if (letterCount / totalLength < 0.3) { // Very lenient now
    console.log('Too many symbols/punctuation:', cleanText);
    return false;
  }
  
  // Allow most single words now (audio detection should handle silence)
  // Only filter out obvious artifacts
  const words = cleanText.split(/\s+/).filter(word => word.length > 0);
  if (words.length === 1) {
    const word = words[0];
    // Only reject very short single characters or numbers
    if (word.length < 2 || /^[0-9]+$/.test(word)) {
      console.log('Single character or number:', cleanText);
      return false;
    }
  }
  
  return true;
}

// Translate text to target languages using direct HTTP API
async function translateText(text, sourceLanguage = 'auto') {
  const translations = {};
  let detectedLanguage = sourceLanguage;
  
  // First, get the detected language by making one translation call
  try {
    const result = await callGoogleTranslateAPI(text, sourceLanguage, 'en');
    if (result.detectedSourceLanguage) {
      const normalizedLang = normalizeLanguageCode(result.detectedSourceLanguage);
      if (!isSupportedLanguage(normalizedLang)) {
        console.log(`Unsupported language detected: ${result.detectedSourceLanguage} (normalized: ${normalizedLang}). Skipping translation.`);
        return null;
      }
      detectedLanguage = result.detectedSourceLanguage;
    }
  } catch (error) {
    console.error('Error detecting language:', error);
    return null;
  }
  
  // Now translate to all target languages
  for (const targetLang of TARGET_LANGUAGES) {
    try {
      if (normalizeLanguageCode(detectedLanguage) === normalizeLanguageCode(targetLang)) {
        // Same language - use original text
        translations[targetLang] = text;
      } else {
        // Different language - translate
        const result = await callGoogleTranslateAPI(text, detectedLanguage, targetLang);
        translations[targetLang] = result.translatedText;
      }
    } catch (error) {
      console.error(`Translation error for ${targetLang}:`, error);
      translations[targetLang] = `[Translation Error]`;
    }
  }
  
  return {
    translations,
    detectedLanguage
  };
}

// Normalize language codes to handle case variations and variants
function normalizeLanguageCode(langCode) {
  if (!langCode) return null;
  
  const normalized = langCode.toLowerCase();
  
  // Map all Chinese variants to 'zh'
  if (normalized.startsWith('zh')) {
    return 'zh';
  }
  
  return normalized;
}

// Check if a language is supported (with normalization)
function isSupportedLanguage(langCode) {
  if (!langCode) return false;
  
  const normalized = normalizeLanguageCode(langCode);
  
  // Supported languages after normalization
  const supportedNormalized = ['en', 'it', 'zh'];
  
  return supportedNormalized.includes(normalized);
}

// Direct Google Translate API call using HTTPS
function callGoogleTranslateAPI(text, sourceLang, targetLang) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.GOOGLE_API_KEY;
    const url = `https://translation.googleapis.com/language/translate/v2?key=${apiKey}`;
    
    const requestBody = {
      q: text,
      target: targetLang,
      format: 'text'
    };
    
    // Only specify source language if it's not auto-detect
    if (sourceLang && sourceLang !== 'auto') {
      requestBody.source = sourceLang;
    }
    
    const postData = JSON.stringify(requestBody);
    
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    
    const req = https.request(url, options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          
          if (res.statusCode === 200 && response.data && response.data.translations) {
            const translation = response.data.translations[0];
            resolve({
              translatedText: translation.translatedText,
              detectedSourceLanguage: translation.detectedSourceLanguage
            });
          } else {
            reject(new Error(`API Error: ${response.error?.message || 'Unknown error'}`));
          }
        } catch (parseError) {
          reject(new Error(`Parse error: ${parseError.message}`));
        }
      });
    });
    
    req.on('error', (error) => {
      reject(error);
    });
    
    req.write(postData);
    req.end();
  });
}

// REST endpoint for file upload (alternative to real-time)
app.post('/upload-audio', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }
    
    const sourceLanguage = req.body.sourceLanguage || 'auto';
    const transcription = await transcribeAudio(req.file.path, sourceLanguage);
    
    if (transcription && transcription.trim()) {
      const result = await translateText(transcription, 'auto');
      
      if (result && result.detectedLanguage) {
        res.json({
          sourceLanguage: result.detectedLanguage,
          sourceText: transcription,
          translations: result.translations
        });
      } else {
        res.json({
          error: 'Unsupported language detected. Please speak in English, Italian, or Chinese.'
        });
      }
    } else {
      res.json({
        error: 'No valid speech detected'
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