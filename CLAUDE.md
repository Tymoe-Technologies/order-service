# 项目Memory - 订单服务

## 重要参考文档

本项目的API文档和设计文档位于父级目录的 PROJECT_SUMMARY.md 中：
路径: /Users/meng/Desktop/CODE/Reall/PROJECT_SUMMARY.md

## API 文档维护规则

重要: 任何 API 接口的修改、新增、删除都必须更新以下两个文件：

### 1. 项目内部文档
- API.md - 本服务的API详细文档
- DESIGN.md - 设计文档
- ORDER-ARCHITECTURE.md - 订单服务架构设计文档

### 2. 父级项目文档
- ../PROJECT_SUMMARY.md - 所有微服务的API汇总表

## 修改流程

当对API进行修改时：
1. 更新本项目的 API 文档文件 (API.md)
2. 更新上级 PROJECT_SUMMARY.md 中对应的服务信息
3. 更新 API 版本号（在相关文档中）
4. 更新最后修改时间戳

不要修改其他目录下的项目，如果需要修改其他目录项目，给出修改请求，不要擅自修改。

## 当前服务信息

服务: Order Service
版本: v1
端口: 3002
路由前缀: /api/order/v1

最后更新: 2026-06-27
