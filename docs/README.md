# TTS Agent Harness — 文档索引

## 运维

| # | 文档 | 内容 |
|---|---|---|
| 001 | [setup](001-setup.md) | 开发环境搭建、端口表、日常命令 |
| 002 | [config-design](002-config-design.md) | 统一配置管理（.env 切环境） |

## 产品

| # | 文档 | 内容 |
|---|---|---|
| 003 | [user-stories](003-user-stories.md) | 用户故事、功能点清单、代码链路审计 |

## 架构

| # | 文档 | 内容 |
|---|---|---|
| ADR-001 | [adr/001-server-stack](adr/001-server-stack.md) | 服务端技术选型（Prefect + FastAPI + Postgres + MinIO） |
| ADR-002 | [adr/002-rewrite-plan](adr/002-rewrite-plan.md) | Agent Teams 重写实施计划 |
| 004 | [frontend-architecture](004-frontend-architecture.md) | 前端分层设计（Zustand + shadcn + openapi-fetch） |

## 测试

| # | 文档 | 内容 |
|---|---|---|
| 006 | [e2e-plan](006-e2e-plan.md) | 全流程 E2E 测试计划（Playwright） |
| 007 | [e2e-test-cases](007-e2e-test-cases.md) | 细粒度测试用例（15 个 TC） |

## 迁移记录

| # | 文档 | 内容 |
|---|---|---|
| 005 | [frontend-migration](005-frontend-migration.md) | 前端组件迁移清单和问题记录 |

## 未来方向

| # | 文档 | 内容 |
|---|---|---|
| 008 | [roadmap-auto-validation](008-roadmap-auto-validation.md) | 自动校验与自动修复 pipeline |

## 过程记录

| 目录 | 内容 |
|---|---|
| [worklogs/](worklogs/) | Agent A1-A11 的工作日志 + W1-W3 wave gate 报告 |
