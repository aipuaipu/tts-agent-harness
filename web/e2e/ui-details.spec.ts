import { test, expect } from '@playwright/test';
import path from 'path';

const EP_ID = `ui-${Date.now().toString(36)}`;

test('UI 细节验证: duration + subtitle切换 + stage pills + config + 快捷键', async ({ page }) => {
  page.on('dialog', dialog => dialog.accept());

  // === 准备: 创建 episode + 切分 + 合成 ===
  await test.step('准备: 创建并合成', async () => {
    await page.goto('/');

    // 创建
    await page.click('text=+ New');
    await page.locator('input').first().fill(EP_ID);
    await page.locator('input[type="file"]').setInputFiles(
      path.join(__dirname, 'fixtures', 'test-script.json')
    );
    await page.click('button:has-text("Create"), button:has-text("创建")');
    await expect(page.locator(`text=${EP_ID}`).first()).toBeVisible({ timeout: 5000 });

    // 选中
    await page.click(`text=${EP_ID}`);
    await expect(page.locator('h2')).toBeVisible({ timeout: 3000 });

    // 切分
    await page.click('button:has-text("切分")');
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 15000 });

    // 合成
    await page.click('button:has-text("合成全部")');
    const deadline = Date.now() + 180000;
    let status = 'running';
    while (status === 'running' && Date.now() < deadline) {
      await page.waitForTimeout(3000);
      try {
        const resp = await page.request.get(`http://localhost:8100/episodes/${EP_ID}`);
        status = (await resp.json()).status;
      } catch { /* keep polling */ }
    }
    await page.screenshot({ path: 'e2e/screenshots/ui-prepared.png' });
  });

  // === TC-03: Duration 列 ===
  await test.step('TC-03: Duration 显示合理值', async () => {
    // 获取所有 Dur 列的文本
    const durCells = page.locator('table tbody tr td:nth-child(3)');
    const count = await durCells.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const text = await durCells.nth(i).textContent();
      if (text && text !== '--') {
        // 应该是 "X.Xs" 格式，X < 30（不是 48695.7s）
        const match = text.match(/^(\d+\.?\d*)s$/);
        expect(match, `Duration "${text}" should match X.Xs format`).toBeTruthy();
        const dur = parseFloat(match![1]);
        expect(dur, `Duration ${dur}s should be < 30s`).toBeLessThan(30);
        expect(dur, `Duration ${dur}s should be > 0`).toBeGreaterThan(0);
      }
    }
    await page.screenshot({ path: 'e2e/screenshots/tc03-duration.png' });
  });

  // === TC-04: 字幕/TTS源 切换 ===
  await test.step('TC-04: Subtitle/TTS 切换', async () => {
    // 默认是字幕模式
    const header = page.locator('th:has-text("Subtitle"), th:has-text("TTS Source")');
    await expect(header).toBeVisible();

    // 记录字幕模式的文本
    const firstCellText = await page.locator('table tbody tr:first-child td:nth-child(5)').textContent();

    // 点 TTS源 按钮
    await page.click('button:has-text("TTS源")');
    await page.waitForTimeout(300);
    const ttsText = await page.locator('table tbody tr:first-child td:nth-child(5)').textContent();

    // 切回字幕
    await page.click('button:has-text("字幕")');
    await page.waitForTimeout(300);
    const subText2 = await page.locator('table tbody tr:first-child td:nth-child(5)').textContent();

    // 切回后应该跟原来一样
    expect(subText2).toBe(firstCellText);
    await page.screenshot({ path: 'e2e/screenshots/tc04-subtitle-switch.png' });
  });

  // === TC-06: Stage Pills ===
  await test.step('TC-06: Stage pills 显示', async () => {
    const pills = page.locator('table .rounded-full.font-mono');
    const count = await pills.count();
    // 每个 chunk 至少有 P2 pill
    expect(count, 'Should have stage pills').toBeGreaterThan(0);
    await page.screenshot({ path: 'e2e/screenshots/tc06-pills.png' });
  });

  // === TC-07: Stage Log Drawer ===
  await test.step('TC-07: 点 pill 打开 drawer', async () => {
    const pill = page.locator('table .rounded-full.font-mono').first();
    if (await pill.isVisible()) {
      await pill.click({ force: true });
      await page.waitForTimeout(1000);

      // drawer 应该出现（右侧固定面板）
      const drawer = page.locator('.fixed.right-0');
      if (await drawer.isVisible({ timeout: 3000 })) {
        await page.screenshot({ path: 'e2e/screenshots/tc07-drawer.png' });
        // 关闭
        await page.locator('button:has-text("✕")').first().click();
      }
    }
  });

  // === TC-08: TTS Config ===
  await test.step('TC-08: Config 修改并保存', async () => {
    // 点 ✎ 编辑按钮
    const editBtn = page.locator('button:has-text("编辑")').first();
    if (await editBtn.isVisible({ timeout: 3000 })) {
      await editBtn.click();
      await page.waitForTimeout(500);

      const tempInput = page.locator('input[type="number"]').first();
      if (await tempInput.isVisible({ timeout: 2000 })) {
        await tempInput.fill('0.3');
        await page.click('button:has-text("保存配置")');
        await page.waitForTimeout(1000);
      }
      await page.screenshot({ path: 'e2e/screenshots/tc08-config.png' });
    }
  });

  // === TC-10: 快捷键 ===
  await test.step('TC-10: 键盘快捷键', async () => {
    // 确保不在 input 里
    await page.click('body');
    await page.waitForTimeout(300);

    // Space → 播放
    await page.keyboard.press('Space');
    await page.waitForTimeout(500);
    // 应该有一个 chunk 在播放（暂停按钮出现）
    const pauseBtn = page.locator('button:has-text("⏸")');
    const isPlaying = await pauseBtn.isVisible({ timeout: 2000 });

    if (isPlaying) {
      // Esc → 停止
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }

    // e → 打开编辑
    await page.keyboard.press('e');
    await page.waitForTimeout(500);
    const textarea = page.locator('textarea').first();
    const editorOpen = await textarea.isVisible({ timeout: 2000 });

    if (editorOpen) {
      // Esc → 关闭编辑
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }
    await page.screenshot({ path: 'e2e/screenshots/tc10-shortcuts.png' });
  });

  // === TC-11: Sidebar 菜单 ===
  await test.step('TC-11: Sidebar ⋯ 菜单', async () => {
    const menuBtn = page.locator('button:has-text("⋯")').first();
    if (await menuBtn.isVisible()) {
      await menuBtn.click();
      // 菜单出现
      await expect(page.locator('button:has-text("Delete")').first()).toBeVisible({ timeout: 2000 });
      await expect(page.locator('button:has-text("Duplicate")').first()).toBeVisible();
      await page.screenshot({ path: 'e2e/screenshots/tc11-menu.png' });
      // 点外面关闭
      await page.click('body');
    }
  });

  // === TC-15: Episode 状态显示 ===
  await test.step('TC-15: 状态显示正确', async () => {
    // 验证 API 返回的 status
    const resp = await page.request.get(`http://localhost:8100/episodes/${EP_ID}`);
    const data = await resp.json();

    if (data.status === 'done') {
      // 按钮应该是 "完成 ✓"
      await expect(page.locator('button:has-text("完成")')).toBeVisible();
    } else if (data.status === 'failed') {
      // 按钮应该是 "重试失败"
      await expect(page.locator('button:has-text("重试失败")')).toBeVisible();
    }
    await page.screenshot({ path: 'e2e/screenshots/tc15-status.png' });
  });

  // === 清理 ===
  await test.step('清理: 删除 episode', async () => {
    // API 删除（UI 删除在 full-pipeline.spec.ts 里已测过）
    await page.request.delete(`http://localhost:8100/episodes/${EP_ID}`);
  });
});
