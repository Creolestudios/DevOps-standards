const { setupCIScript, ensureProjectScripts, setupCIWorkflow, setupPrePushHook } = require('./lib/ci');
const fs = require('fs-extra');
const path = require('path');

async function test() {
    const testDir = '/Users/creolemacbookpro/Desktop/DemoTest_Newman/test-integration-dir';
    process.chdir(testDir);
    
    console.log('Testing ensureProjectScripts...');
    await ensureProjectScripts();
    
    console.log('Testing setupCIScript...');
    await setupCIScript(testDir);
    
    console.log('Testing setupCIWorkflow...');
    await setupCIWorkflow();
    
    console.log('Testing setupPrePushHook...');
    await setupPrePushHook(testDir);
    
    console.log('Verification steps completed.');
}

test().catch(console.error);
