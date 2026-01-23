#!/usr/bin/env node

/**
 * Quick Chat API Tester
 * 
 * Usage: node test-chat.js
 * 
 * This script:
 * 1. Lists all cases from your SQLite database
 * 2. Lets you pick one interactively
 * 3. Runs a test chat message against that case
 * 4. Shows the formatted response
 */

const Database = require('better-sqlite3');
const readline = require('readline');
const https = require('https');
const http = require('http');

// Configuration
const DB_PATH = './data/chase-agent.db';
const API_URL = 'http://localhost:3000/api/agent/chat';

// ANSI colors for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
};

// Helper to print colored text
function print(text, color = 'reset') {
  console.log(`${colors[color]}${text}${colors.reset}`);
}

// Load cases from database
function loadCases() {
  try {
    const db = new Database(DB_PATH, { readonly: true });
    const cases = db.prepare(`
      SELECT 
        case_id,
        po_number,
        line_id,
        supplier_name,
        supplier_email,
        missing_fields,
        state,
        status
      FROM cases
      ORDER BY created_at DESC
      LIMIT 20
    `).all();
    db.close();
    return cases;
  } catch (error) {
    print(`❌ Error loading cases: ${error.message}`, 'red');
    process.exit(1);
  }
}

// Display cases as a numbered list
function displayCases(cases) {
  print('\n📋 Available Cases:\n', 'bright');
  
  cases.forEach((c, idx) => {
    const missingFields = JSON.parse(c.missing_fields || '[]');
    const missingStr = missingFields.length > 0 
      ? ` (missing: ${missingFields.join(', ')})` 
      : ' (all fields confirmed)';
    
    print(`  ${idx + 1}. PO ${c.po_number}-${c.line_id}`, 'cyan');
    print(`     Supplier: ${c.supplier_name || 'Unknown'}`, 'reset');
    print(`     State: ${c.state}${missingStr}`, 'yellow');
    print(`     Case ID: ${c.case_id}\n`, 'reset');
  });
}

// Prompt user to select a case
function promptForCase(cases) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(colors.bright + '❓ Select a case number (or "q" to quit): ' + colors.reset, (answer) => {
      rl.close();
      
      if (answer.toLowerCase() === 'q') {
        print('\n👋 Goodbye!\n', 'yellow');
        process.exit(0);
      }
      
      const caseNum = parseInt(answer, 10);
      if (isNaN(caseNum) || caseNum < 1 || caseNum > cases.length) {
        print('\n❌ Invalid case number. Try again.\n', 'red');
        return promptForCase(cases).then(resolve);
      }
      
      resolve(cases[caseNum - 1]);
    });
  });
}

// Prompt for custom message
function promptForMessage(defaultMessage) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    print(`\n💬 Default message: "${defaultMessage}"`, 'cyan');
    rl.question(colors.bright + '   Enter custom message (or press Enter to use default): ' + colors.reset, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultMessage);
    });
  });
}

// Make API request
function testChat(caseId, message) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      message,
      caseId,
      conversationHistory: []
    });

    const url = new URL(API_URL);
    const options = {
      hostname: url.hostname,
      port: url.port || 3000,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const client = url.protocol === 'https:' ? https : http;
    
    const req = client.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          resolve({ statusCode: res.statusCode, data: response });
        } catch (error) {
          reject(new Error(`Failed to parse response: ${error.message}`));
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

// Display the chat response
function displayResponse(response) {
  print('\n' + '═'.repeat(80), 'blue');
  print('🤖 AGENT RESPONSE', 'bright');
  print('═'.repeat(80) + '\n', 'blue');

  if (response.statusCode !== 200) {
    print(`❌ Error (${response.statusCode}):`, 'red');
    print(JSON.stringify(response.data, null, 2), 'red');
    return;
  }

  const { message, toolCalls, conversationHistory } = response.data;

  if (message) {
    print('💬 Message:', 'green');
    print(message + '\n', 'reset');
  }

  if (toolCalls && toolCalls.length > 0) {
    print('🔧 Tools Called:', 'yellow');
    toolCalls.forEach((tool, idx) => {
      print(`   ${idx + 1}. ${tool.name}`, 'cyan');
      print(`      Args: ${JSON.stringify(tool.arguments, null, 6)}`, 'reset');
      if (tool.result) {
        print(`      Result: ${JSON.stringify(tool.result, null, 6)}\n`, 'reset');
      }
    });
  }

  if (conversationHistory && conversationHistory.length > 0) {
    print('\n📝 Full Conversation:', 'yellow');
    conversationHistory.forEach((msg) => {
      const role = msg.role === 'user' ? '👤' : '🤖';
      print(`   ${role} ${msg.role.toUpperCase()}:`, msg.role === 'user' ? 'cyan' : 'green');
      print(`      ${msg.content}\n`, 'reset');
    });
  }

  print('═'.repeat(80) + '\n', 'blue');
}

// Main execution
async function main() {
  print('\n🚀 Chat API Tester\n', 'bright');

  // Load cases
  const cases = loadCases();
  
  if (cases.length === 0) {
    print('❌ No cases found in database. Upload some PO data first.\n', 'red');
    process.exit(1);
  }

  // Display and select case
  displayCases(cases);
  const selectedCase = await promptForCase(cases);

  print(`\n✅ Selected: PO ${selectedCase.po_number}-${selectedCase.line_id}`, 'green');
  print(`   Supplier: ${selectedCase.supplier_name || 'Unknown'}`, 'reset');
  print(`   Case ID: ${selectedCase.case_id}\n`, 'reset');

  // Get message
  const defaultMessage = `Can you check if we have confirmation for PO ${selectedCase.po_number}?`;
  const message = await promptForMessage(defaultMessage);

  // Make request
  print('\n⏳ Sending request to API...\n', 'yellow');
  
  try {
    const response = await testChat(selectedCase.case_id, message);
    displayResponse(response);
  } catch (error) {
    print(`\n❌ Request failed: ${error.message}\n`, 'red');
    print('💡 Make sure your dev server is running: npm run dev\n', 'yellow');
    process.exit(1);
  }

  // Ask if want to test another
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.question(colors.bright + '🔄 Test another case? (y/n): ' + colors.reset, (answer) => {
    rl.close();
    if (answer.toLowerCase() === 'y') {
      main();
    } else {
      print('\n👋 Done! Happy coding!\n', 'green');
      process.exit(0);
    }
  });
}

// Run if called directly
if (require.main === module) {
  main().catch((error) => {
    print(`\n❌ Fatal error: ${error.message}\n`, 'red');
    console.error(error);
    process.exit(1);
  });
}

module.exports = { loadCases, testChat };