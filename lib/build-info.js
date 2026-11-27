/**
 * 发版印章：随包安装的这一份实现对应哪个提交。
 * 由 scripts/stamp.mjs 在发版/部署前写入（git HEAD 的 sha），不要手改。
 * 为 null 表示「不知道」，此时自更新只以「远端 sha ≠ 当前 sha」判断是否有新版本。
 */
export const BUNDLED_SHA = 'cc8baef29a0b1c378d9d1959756a3b0b9d0d34bf';
