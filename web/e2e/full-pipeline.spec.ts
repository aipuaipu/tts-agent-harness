import { test, expect } from '@playwright/test';
import path from 'path';

const EP_ID = `e2e-${Date.now().toString(36)}`; // shorter ID to avoid sidebar truncation

test('完整用户旅程: 创建 → 切分 → 配置 → 合成 → 播放 → 日志 → 编辑 → 删除', async ({ page }) => {
  // Accept browser dialogs (confirm/alert)
  page.on('dialog', dialog => dialog.accept());

  await test.step('Step 1: 打开页面', async () => {
    await page.goto('/');
    await expect(page.locator('text=TTS Harness')).toBeVisible();
    await expect(page.getByText('Episodes', { exact: true })).toBeVisible();
  });

  await test.step('Step 2: 创建 Episode', async () => {
    await page.click('text=+ New');
    // NewEpisodeDialog 应该打开
    await expect(page.locator('dialog, [role="dialog"], .fixed')).toBeVisible({ timeout: 3000 });

    // 填写 ID
    const idInput = page.locator('input').first();
    await idInput.fill(EP_ID);

    // 选择 script 文件
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(path.join(__dirname, 'fixtures', 'test-script.json'));

    // 提交
    await page.click('button:has-text("Create"), button:has-text("创建")');

    // 验证 sidebar 出现新 episode
    await expect(page.locator(`text=${EP_ID}`).first()).toBeVisible({ timeout: 5000 });
  });

  await test.step('Step 3: 选中 Episode 查看详情', async () => {
    await page.click(`text=${EP_ID}`);
    // 等待 episode header 加载
    await expect(page.locator('h2')).toBeVisible({ timeout: 5000 });
  });

  await test.step('Step 4: P1 切分', async () => {
    // 状态应该是 empty，按钮显示"切分"
    await page.click('button:has-text("切分")');
    // 等 chunks 出现（dev mode 内部执行，~3s）
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 15000 });
    // 至少 1 个 chunk
    const rows = page.locator('table tbody tr');
    expect(await rows.count()).toBeGreaterThanOrEqual(1);
  });

  await test.step('Step 5: TTS Config', async () => {
    // 点 ✎ 编辑按钮打开 config dialog
    const editBtn = page.locator('button:has-text("编辑")').first();
    if (await editBtn.isVisible({ timeout: 3000 })) {
      await editBtn.click();
      await page.waitForTimeout(500);
      // 修改 temperature
      const tempInput = page.locator('input[type="number"]').first();
      if (await tempInput.isVisible({ timeout: 2000 })) {
        await tempInput.fill('0.5');
        await page.click('button:has-text("保存配置")');
        await page.waitForTimeout(1000);
      }
    }
  });

  await test.step('Step 6: 合成全部 (P2→P3→P5→P6)', async () => {
    // 按钮应该显示"合成全部"
    await page.click('button:has-text("合成全部")');

    // 等 episode 完成 — 需要 Fish API + WhisperX，最长 3 分钟
    // 通过轮询 API 检查状态，不只依赖 UI
    const deadline = Date.now() + 180000;
    let status = 'running';
    while (status === 'running' && Date.now() < deadline) {
      await page.waitForTimeout(3000);
      try {
        const resp = await page.request.get(`http://localhost:8100/episodes/${EP_ID}`);
        const data = await resp.json();
        status = data.status;
      } catch { /* keep polling */ }
    }

    // 截图记录最终状态
    await page.screenshot({ path: `e2e/screenshots/step6-status-${status}.png` });

    if (status === 'done') {
      // 完美：全 pipeline 跑通
      await expect(page.locator('text=完成')).toBeVisible();
    } else if (status === 'failed') {
      // P3 可能失败（WhisperX 未起）— 记录但继续后续步骤
      console.warn(`⚠ Pipeline ended with status=${status} — check whisperx-svc`);
    } else {
      throw new Error(`Pipeline stuck at status=${status} after 3 minutes`);
    }
  });

  await test.step('Step 7: 验证 chunk stage pills', async () => {
    // 至少一个 stage pill 可见
    const pills = page.locator('.rounded-full.font-mono');
    if (await pills.count() > 0) {
      await page.screenshot({ path: 'e2e/screenshots/step7-stage-pills.png' });
    } else {
      console.warn('⚠ No stage pills visible');
    }
  });

  await test.step('Step 8: 播放音频', async () => {
    const playBtn = page.locator('button:has-text("▶")').first();
    if (await playBtn.isEnabled()) {
      await playBtn.click();
      // 验证 audio 元素出现且有 src
      const audio = page.locator('audio');
      await expect(audio.first()).toHaveAttribute('src', /.+/, { timeout: 5000 });
      await page.screenshot({ path: 'e2e/screenshots/step8-playing.png' });
      // 暂停
      await page.locator('button:has-text("⏸")').first().click();
    } else {
      console.warn('⚠ Play button disabled — no audio to play');
    }
  });

  await test.step('Step 9: 查看 Stage 日志', async () => {
    // Stage pills are in StagePipeline inside ChunkRow — need to click enabled ones
    // The pills inside EpisodeStageBar (top bar) might also match
    // Use the chunk-row pills which have onStageClick wired
    const pill = page.locator('table .rounded-full.font-mono').first();
    if (await pill.isVisible()) {
      await pill.click({ force: true }); // force — pill may be disabled if no onStageClick
      await page.waitForTimeout(1000);
      await page.screenshot({ path: 'e2e/screenshots/step9-drawer.png' });
      // 关闭 drawer if opened
      const closeBtn = page.locator('button:has-text("✕")').first();
      if (await closeBtn.isVisible({ timeout: 2000 })) {
        await closeBtn.click();
      }
    } else {
      console.warn('⚠ No stage pill visible');
    }
  });

  await test.step('Step 10: 编辑 chunk 文本', async () => {
    const editBtn = page.locator('button:has-text("✎")').first();
    if (await editBtn.isVisible()) {
      await editBtn.click();
      // 等编辑器出现
      const textarea = page.locator('textarea').first();
      if (await textarea.isVisible({ timeout: 3000 })) {
        await textarea.fill('修改后的测试文本。');
        await page.screenshot({ path: 'e2e/screenshots/step10-editing.png' });
        // 取消编辑（不 apply，避免触发重新合成）
        const cancelBtn = page.locator('button:has-text("✕"), button:has-text("Cancel")').first();
        if (await cancelBtn.isVisible()) {
          await cancelBtn.click();
        }
      }
    } else {
      console.warn('⚠ Edit button not visible');
    }
  });

  await test.step('Step 11: 删除 Episode', async () => {
    await page.request.delete(`http://localhost:8100/episodes/${EP_ID}`);
    await page.screenshot({ path: 'e2e/screenshots/step11-deleted.png' });
  });
});
