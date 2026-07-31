/**
 * Test suite for header.js encoding function
 */

const { encodeFilename } = require('./header');

function testEncodingFunction() {
  console.log('='.repeat(60));
  console.log('Testing encodeFilename function for non-ASCII support');
  console.log('='.repeat(60));

  const testCases = [
    {
      name: 'ASCII filename',
      input: 'music.mp3',
      shouldContain: 'filename="music.mp3"',
      shouldNotContain: 'filename*='
    },
    {
      name: 'Chinese characters',
      input: '音乐.mp3',
      shouldContain: 'filename="__.mp3"',
      shouldContain2: "filename*=UTF-8''",
      shouldContain3: '%E9%9F%B3%E4%B9%90'
    },
    {
      name: 'Arabic characters',
      input: 'موسيقى.mp3',
      shouldContain: 'filename="______.mp3"',
      shouldContain2: "filename*=UTF-8''"
    },
    {
      name: 'Mixed ASCII and non-ASCII',
      input: 'Song - 日本語.mp3',
      shouldContain: 'filename="Song - ___.mp3"',
      shouldContain2: "filename*=UTF-8''"
    },
    {
      name: 'Filename with special characters',
      input: 'My "Song" (feat. Artist).mp3',
      shouldContain: 'filename="My \\"Song\\" (feat. Artist).mp3"'
    },
    {
      name: 'Emoji in filename',
      input: '🎵Music🎸.mp3',
      shouldContain: 'filename="__Music__.mp3"',
      shouldContain2: "filename*=UTF-8''"
    }
  ];

  let passed = 0;
  let failed = 0;

  testCases.forEach((testCase, index) => {
    console.log(`\n[Test ${index + 1}] ${testCase.name}`);
    console.log(`Input: "${testCase.input}"`);
    
    try {
      const result = encodeFilename(testCase.input);
      console.log(`Output: ${result}`);
      
      let testPassed = true;
      
      if (testCase.shouldContain && !result.includes(testCase.shouldContain)) {
        console.log(`❌ FAILED: Should contain "${testCase.shouldContain}"`);
        testPassed = false;
      }
      
      if (testCase.shouldContain2 && !result.includes(testCase.shouldContain2)) {
        console.log(`❌ FAILED: Should contain "${testCase.shouldContain2}"`);
        testPassed = false;
      }
      
      if (testCase.shouldContain3 && !result.includes(testCase.shouldContain3)) {
        console.log(`❌ FAILED: Should contain "${testCase.shouldContain3}"`);
        testPassed = false;
      }
      
      if (testCase.shouldNotContain && result.includes(testCase.shouldNotContain)) {
        console.log(`❌ FAILED: Should NOT contain "${testCase.shouldNotContain}"`);
        testPassed = false;
      }
      
      if (testPassed) {
        console.log('✅ PASSED');
        passed++;
      } else {
        failed++;
      }
      
    } catch (error) {
      console.log(`❌ FAILED with error: ${error.message}`);
      failed++;
    }
  });

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));
  
  // Test that header would not contain invalid characters
  console.log('\nValidating header safety...');
  const headerTest = testCases.slice(1).forEach((testCase) => {
    const result = encodeFilename(testCase.input);
    const headerValue = `attachment; ${result}`;
    
    // Check for invalid characters (0x00-0x1F and 0x7F)
    let hasInvalidChars = false;
    for (let i = 0; i < headerValue.length; i++) {
      const charCode = headerValue.charCodeAt(i);
      if ((charCode >= 0x00 && charCode <= 0x1F) || charCode === 0x7F) {
        hasInvalidChars = true;
        break;
      }
    }
    
    if (hasInvalidChars) {
      console.log(`❌ "${testCase.input}" produces invalid header characters`);
    } else {
      console.log(`✅ "${testCase.input}" produces valid header`);
    }
  });
}

// Run tests
testEncodingFunction();
