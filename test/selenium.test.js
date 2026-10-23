import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Builder, By } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';
import { start } from '../server.js';

const quizPath = path.join(tmpdir(), 'zz-selenium.json');
const savedQuiz = path.resolve('quizzes/zz-selenium.json');
const chromeBinary = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function quizFile() {
  writeFileSync(quizPath, JSON.stringify({
    title: 'Coverage',
    questions: [
      { question: 'The Pacific Ocean is the largest ocean.', answers: ['True', 'False'], correct: 1 },
      { question: 'Which planet is famous for its rings?', answers: ['Jupiter', 'Saturn', 'Mars', 'Venus'], correct: 2 },
      { question: 'Tokyo is the capital of Japan.', answers: ['True', 'False'], correct: true },
    ],
  }));
}

async function untilText(driver, text, ms = 15000) {
  let last = '';
  try {
    await driver.wait(async () => {
      last = await driver.findElement(By.css('body')).getText();
      return last.toLowerCase().includes(String(text).toLowerCase());
    }, ms);
  } catch (error) {
    throw new Error(`${text} did not appear.\n${last}`, { cause: error });
  }
}

async function clickButton(driver, text) {
  await driver.wait(async () => {
    const buttons = await driver.findElements(By.css('button'));
    for (const button of buttons) {
      if ((await button.getText()).includes(text)) {
        await button.click();
        return true;
      }
    }
    return false;
  }, 10000, text);
}

async function bodyText(driver) {
  return driver.findElement(By.css('body')).getText();
}

async function nextRect(driver) {
  const rect = await driver.findElement(By.css('.next-dock button')).getRect();
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

describe('selenium browser game', { concurrency: false, timeout: 120000 }, () => {
  let server;
  let host;
  let ada;
  let cam;

  before(async () => {
    process.env.QUESTION_MS = '30000';
    quizFile();
    server = await start(0);
    const options = new chrome.Options();
    options.setChromeBinaryPath(chromeBinary);
    options.addArguments('--headless=new', '--disable-gpu', '--window-size=1280,900');
    const build = () => new Builder().forBrowser('chrome').setChromeOptions(options).build();
    host = await build();
    ada = await build();
    cam = await build();
  });

  after(async () => {
    delete process.env.QUESTION_MS;
    rmSync(quizPath, { force: true });
    rmSync(savedQuiz, { force: true });
    await Promise.all([host, ada, cam].filter(Boolean).map((driver) => driver.quit().catch(() => {})));
    if (server) await server.stop();
  });

  test('a host and two phones play a true or false quiz through the podium', async () => {
    mkdirSync(path.dirname(savedQuiz), { recursive: true });
    const base = `http://127.0.0.1:${server.port}`;
    await host.get(`${base}/host`);
    await untilText(host, 'Host a quiz');
    assert.equal(await host.findElement(By.css('img.logo')).getAttribute('alt'), 'Not Kahoot');
    assert.ok(parseFloat(await host.findElement(By.css('img.logo')).getCssValue('width')) > 40);
    await untilText(host, 'Warm-up');
    await untilText(host, '12 questions');

    await host.executeScript(() => {
      const input = document.querySelector('[data-upload]');
      input.style.cssText = 'position:fixed;opacity:1;width:40px;height:40px;left:0;top:0;clip:auto';
    });
    await host.findElement(By.css('[data-upload]')).sendKeys(quizPath);
    await untilText(host, 'Coverage');
    await host.executeScript(() => {
      const card = [...document.querySelectorAll('.quiz-card')].find((node) => node.textContent.includes('Coverage'));
      card.querySelector('[data-action="host"]').click();
    });
    await untilText(host, 'Game code');
    await untilText(host, 'Scan to join');
    assert.ok(await host.findElement(By.css('.qr svg')));

    await host.executeScript(() => {
      document.querySelector('[data-option="shuffleQuestions"]').click();
      document.querySelector('[data-option="shuffleAnswers"]').click();
    });
    await host.wait(async () => {
      try {
        const questions = await host.findElement(By.css('[data-option="shuffleQuestions"]')).isSelected();
        const answers = await host.findElement(By.css('[data-option="shuffleAnswers"]')).isSelected();
        return questions === false && answers === false;
      } catch (error) {
        if (String(error.name).includes('Stale')) return false;
        throw error;
      }
    }, 5000);
    await host.sleep(250);
    await host.manage().window().setRect({ width: 390, height: 844, x: 0, y: 0 });
    const narrow = await bodyText(host);
    assert.match(narrow, /game code/i);
    await host.manage().window().setRect({ width: 1280, height: 900, x: 0, y: 0 });

    const code = (await host.findElement(By.css('.code')).getText()).replace(/\D/g, '');
    assert.equal(code.length, 6);

    await ada.get(`${base}/?code=000000`);
    assert.equal(await ada.findElement(By.css('img.logo')).getAttribute('alt'), 'Not Kahoot');
    await ada.findElement(By.css('input[name="name"]')).sendKeys('Ada');
    await ada.findElement(By.css('button[type="submit"]')).click();
    await untilText(ada, 'No game found');

    await ada.get(`${base}/?code=${code}`);
    assert.equal(await ada.findElement(By.css('input[name="code"]')).getAttribute('value'), `${code.slice(0, 3)} ${code.slice(3)}`);
    await ada.findElement(By.css('input[name="name"]')).sendKeys('Ada');
    await ada.findElement(By.css('button[type="submit"]')).click();
    await untilText(ada, "You're in");
    await untilText(host, 'Ada');

    await cam.get(`${base}/?code=${code}`);
    await cam.findElement(By.css('input[name="name"]')).sendKeys('Ada');
    await cam.findElement(By.css('button[type="submit"]')).click();
    await untilText(cam, 'already in this game');
    await cam.findElement(By.css('input[name="name"]')).clear();
    await cam.findElement(By.css('input[name="name"]')).sendKeys('Cam');
    await cam.findElement(By.css('button[type="submit"]')).click();
    await untilText(cam, "You're in");
    await untilText(host, '2 joined');

    await ada.findElement(By.css('[data-leave]')).click();
    await untilText(ada, 'Join a game');
    await untilText(host, '1 joined');
    await ada.findElement(By.css('input[name="code"]')).clear();
    await ada.findElement(By.css('input[name="code"]')).sendKeys(code);
    await ada.findElement(By.css('input[name="name"]')).sendKeys('Ada');
    await ada.findElement(By.css('button[type="submit"]')).click();
    await untilText(host, '2 joined');

    await clickButton(host, 'Start quiz');
    await untilText(host, 'Get ready');
    await untilText(ada, 'Get ready');
    await untilText(host, 'The Pacific Ocean is the largest ocean.');
    assert.equal((await host.findElements(By.css('.timer [data-bar], .answer-count [data-bar]'))).length, 0);
    assert.equal((await ada.findElements(By.css('.timebar'))).length, 0);
    assert.ok(await host.findElement(By.css('.stripe[data-bar]')));
    assert.ok(await ada.findElement(By.css('.stripe[data-bar]')));
    assert.match(await host.findElement(By.css('.stripe')).getCssValue('transform-origin'), /^0px/);
    assert.equal(await host.findElement(By.css('.prompt')).getCssValue('text-align'), 'center');
    assert.equal(await host.findElement(By.css('.answer-count')).getText(), '0');
    const questionNext = await nextRect(host);
    await clickButton(host, 'End Quiz');
    await untilText(host, 'Are you sure you want to end the quiz');
    await clickButton(host, 'Keep playing');
    await host.wait(async () => (await host.findElements(By.css('.confirm-end'))).length === 0, 4000);
    assert.match(await bodyText(host), /Pacific Ocean/);
    assert.deepEqual(await nextRect(host), questionNext);
    await untilText(ada, 'True or false');
    const words = await ada.findElements(By.css('.choice-word'));
    assert.deepEqual(await Promise.all(words.map((word) => word.getText())), ['True', 'False']);
    const hostLabels = await host.findElements(By.css('.answer-card .label'));
    assert.deepEqual(await Promise.all(hostLabels.map((label) => label.getText())), ['True', 'False']);

    await cam.findElement(By.xpath("//button[contains(., 'True')]")).click();
    await host.wait(async () => (await host.findElement(By.css('.answer-count')).getText()) === '1', 8000);
    await ada.findElement(By.xpath("//button[contains(., 'False')]")).click();
    await host.wait(async () => (await host.findElements(By.css('.answer-card.is-correct'))).length === 1, 8000);
    assert.equal((await bodyText(host)).toLowerCase().includes('got it right'), false);
    assert.equal((await host.findElements(By.css('.tally'))).length, 0);
    const correctCard = await host.findElement(By.css('.answer-card.is-correct'));
    const fadedCard = await host.findElement(By.css('.answer-card.is-faded'));
    const correctColour = await correctCard.getCssValue('background-image');
    const fadedColour = await fadedCard.getCssValue('background-image');
    assert.ok(parseFloat(await correctCard.getCssValue('outline-width')) >= 6);
    assert.ok(parseFloat(await fadedCard.getCssValue('opacity')) < 0.7);
    assert.deepEqual(await nextRect(host), questionNext);
    await untilText(cam, 'Correct');
    await untilText(cam, 'Streak 1');
    await untilText(cam, 'points ahead of Ada');
    assert.equal(await cam.findElement(By.css('.rank-circle.mini')).getText(), '2nd');
    await untilText(ada, 'Not this time');
    await untilText(ada, 'Streak 0');
    await untilText(ada, 'points behind Cam');
    await untilText(ada, '2nd');
    assert.equal(await ada.findElement(By.css('.rank-circle.mini')).getText(), '1st');
    const ownRank = parseFloat(await ada.findElement(By.css('.rank-mark .rank-circle')).getCssValue('font-size'));
    const rivalRank = parseFloat(await ada.findElement(By.css('.rank-circle.mini')).getCssValue('font-size'));
    assert.ok(rivalRank < ownRank);
    await untilText(host, 'Answers');
    assert.deepEqual(await nextRect(host), questionNext);
    const trueBar = await host.findElement(By.css('.bar-row.is-correct'));
    const falseBar = await host.findElement(By.css('.bar-row:not(.is-correct)'));
    assert.match(await trueBar.getAttribute('aria-label'), /True/);
    assert.match(await trueBar.getText(), /✓/);
    assert.match(await falseBar.getAttribute('aria-label'), /False/);
    assert.equal((await falseBar.getText()).includes('✓'), false);
    assert.ok(await trueBar.findElement(By.css('.bar-score .bar-tick')));
    assert.ok(await trueBar.findElement(By.css('.bar-foot svg')));
    assert.ok(await falseBar.findElement(By.css('.bar-foot svg')));
    assert.equal(await trueBar.findElement(By.css('.bar-label')).getText(), 'True');
    assert.equal(await falseBar.findElement(By.css('.bar-label')).getText(), 'False');
    assert.equal(await trueBar.findElement(By.css('.bar-col')).getCssValue('background-image'), correctColour);
    assert.equal(await falseBar.findElement(By.css('.bar-col')).getCssValue('background-image'), fadedColour);
    assert.ok(parseFloat(await falseBar.getCssValue('opacity')) > 0.85);
    assert.equal(/grayscale/.test(await falseBar.getCssValue('filter')), false);
    const scoreInk = (await host.findElement(By.css('.bar-count')).getCssValue('color')).match(/\d+/g).map(Number);
    assert.ok(scoreInk[0] > 180 && scoreInk[1] > 180 && scoreInk[2] > 180);
    assert.equal(await host.findElement(By.css('.bars')).getCssValue('background-color'), 'rgba(0, 0, 0, 0)');
    await clickButton(host, 'Next');
    await untilText(host, 'Leaderboard');
    assert.deepEqual(await nextRect(host), questionNext);
    let standings = '';
    await host.wait(async () => {
      const rows = await host.findElements(By.css('.board li'));
      const names = [];
      for (const row of rows) names.push(await row.getText());
      standings = names.join(' | ');
      return names[0]?.toLowerCase().includes('cam');
    }, 8000).catch((error) => {
      throw new Error(`Cam should be first. Board: ${standings}`, { cause: error });
    });
    assert.equal((await host.findElements(By.css('.track'))).length, 0);
    assert.equal((await host.findElements(By.css('.streak'))).length, 0);
    await untilText(ada, 'You are');
    const adaBoard = await ada.findElement(By.css('body')).getText();
    assert.equal(adaBoard.toLowerCase().includes('top 7'), false);
    assert.match(adaBoard, /points behind/);

    await clickButton(host, 'Next');
    await untilText(host, 'Which planet is famous for its rings?');
    const labels = await host.findElements(By.css('.answer-card .label'));
    assert.deepEqual(await Promise.all(labels.map((label) => label.getText())), ['Jupiter', 'Saturn', 'Mars', 'Venus']);
    await ada.findElement(By.css('.choice.yellow')).click();
    await cam.findElement(By.css('.choice.yellow')).click();
    await untilText(cam, 'Streak 2');
    await untilText(cam, 'points ahead');
    await untilText(ada, 'Correct');
    await untilText(ada, 'points behind');
    await untilText(host, 'Answers');
    await clickButton(host, 'Next');
    await untilText(host, 'Leaderboard');

    await clickButton(host, 'Next');
    await untilText(host, 'Tokyo is the capital of Japan.');
    await ada.findElement(By.xpath("//button[contains(., 'True')]")).click();
    await cam.findElement(By.xpath("//button[contains(., 'True')]")).click();
    await untilText(cam, 'Streak 3');
    await untilText(host, 'Answers');
    await clickButton(host, 'Next');
    await untilText(host, 'Leaderboard');
    await clickButton(host, 'Next');
    await untilText(host, 'Top 3');
    await untilText(ada, 'Number 2');
    await untilText(cam, 'Number 1');
    await clickButton(host, 'End Quiz');
    await untilText(host, 'Are you sure you want to end the quiz');
    await clickButton(host, 'Yes, end the quiz');
    await untilText(host, 'Host a quiz');
    await untilText(ada, 'The host ended this game');
    await untilText(cam, 'The host ended this game');
  });
});
