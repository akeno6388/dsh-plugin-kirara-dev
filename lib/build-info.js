/**
 * 发版印章：随包安装的这一份实现对应哪个提交。
 * 由 scripts/stamp.mjs 在发版/部署前写入（git HEAD 的 sha），不要手改。
 * 为 null 表示「不知道」，此时自更新只以「远端 sha ≠ 当前 sha」判断是否有新版本。
 */
export const BUNDLED_SHA = '0c95b3ebf0725982431f7125a5c80756bb167506';
