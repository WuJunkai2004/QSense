// M0 验收：配置校验——合法通过、缺项/非法报错可操作（不依赖真实QQ凭据）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config';

const baseEnv = {
  QQ_APPS: '[{"appid":"123456","secret":"s3cr3t-value","name":"主bot"}]',
  MCP_TOKEN: 'x'.repeat(32),
};

test('合法配置通过校验并给出默认值', () => {
  const cfg = loadConfig({ ...baseEnv });
  assert.equal(cfg.apps.length, 1);
  assert.equal(cfg.apps[0].appid, '123456');
  assert.equal(cfg.apps[0].name, '主bot');
  assert.equal(cfg.port, 8787);
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.dataDir, './data');
  assert.equal(cfg.sendEnabled, false);
  assert.equal(cfg.allowGroups.length, 0);
  assert.equal(cfg.logContent, false);
});

test('多bot解析：name 缺省回落 appid，重复 appid 拒绝', () => {
  const cfg = loadConfig({
    ...baseEnv,
    QQ_APPS: '[{"appid":"111","secret":"a"},{"appid":"222","secret":"b"}]',
  });
  assert.deepEqual(cfg.apps.map((a) => a.appid), ['111', '222']);
  assert.equal(cfg.apps[0].name, '111');

  assert.throws(
    () => loadConfig({ ...baseEnv, QQ_APPS: '[{"appid":"111","secret":"a"},{"appid":"111","secret":"b"}]' }),
    (e: Error) => e.message.includes('111'),
  );
});

test('ALLOW_GROUPS 按逗号/空白拆分', () => {
  const cfg = loadConfig({
    ...baseEnv,
    SEND_ENABLE: 'true',
    ALLOW_GROUPS: 'abc, def\nghi',
  });
  assert.deepEqual(cfg.allowGroups, ['abc', 'def', 'ghi']);
  assert.equal(cfg.sendEnabled, true);
});

test('缺 QQ_APPS / MCP_TOKEN 报可操作错误', () => {
  assert.throws(() => loadConfig({}), (e: Error) => e.message.includes('QQ_APPS'));
  assert.throws(
    () => loadConfig({ QQ_APPS: baseEnv.QQ_APPS }),
    (e: Error) => e.message.includes('MCP_TOKEN'),
  );
});

test('QQ_APPS 非法 JSON / 非数组 / 缺字段 报可操作错误', () => {
  assert.throws(
    () => loadConfig({ ...baseEnv, QQ_APPS: '{oops' }),
    (e: Error) => e.message.includes('QQ_APPS'),
  );
  assert.throws(
    () => loadConfig({ ...baseEnv, QQ_APPS: '{"appid":"1"}' }),
    (e: Error) => e.message.includes('QQ_APPS'),
  );
  assert.throws(
    () => loadConfig({ ...baseEnv, QQ_APPS: '[{"appid":"111"}]' }),
    (e: Error) => e.message.includes('secret'),
  );
});

test('MCP_TOKEN 过短拒绝', () => {
  assert.throws(
    () => loadConfig({ ...baseEnv, MCP_TOKEN: 'short' }),
    (e: Error) => e.message.includes('MCP_TOKEN'),
  );
});

test('SEND_ENABLE=true 而无白名单直接拒绝（双重门禁）', () => {
  assert.throws(
    () => loadConfig({ ...baseEnv, SEND_ENABLE: 'true' }),
    (e: Error) => e.message.includes('ALLOW_GROUPS'),
  );
});

test('非法布尔值与端口拒绝', () => {
  assert.throws(
    () => loadConfig({ ...baseEnv, SEND_ENABLE: 'yes' }),
    (e: Error) => e.message.includes('SEND_ENABLE'),
  );
  assert.throws(
    () => loadConfig({ ...baseEnv, PORT: '0' }),
    (e: Error) => e.message.includes('PORT'),
  );
  assert.throws(
    () => loadConfig({ ...baseEnv, PORT: 'abc' }),
    (e: Error) => e.message.includes('PORT'),
  );
});
