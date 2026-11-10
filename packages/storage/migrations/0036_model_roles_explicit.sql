-- 模型可见角色从「空数组 = 全员可见」改为「必须显式授权角色」。
-- 为保留升级前已有模型的可访问性，把此前 roles 为空的老模型回填为当前公司的全部角色；
-- 之后新建或编辑时取消全部勾选，就表示该模型不对任何成员开放。
UPDATE models
SET roles = (
  SELECT json_group_array(code)
  FROM (
    SELECT code
    FROM roles
    WHERE roles.company_id = models.company_id
      AND roles.deleted_at IS NULL
    ORDER BY code
  )
)
WHERE models.deleted_at IS NULL
  AND (models.roles IS NULL OR models.roles = '' OR models.roles = '[]')
  AND EXISTS (
    SELECT 1
    FROM roles
    WHERE roles.company_id = models.company_id
      AND roles.deleted_at IS NULL
  );
