const express = require('express');
const { sql } = require('@vercel/postgres');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ---------- API Эндпоинты ----------

// Получить список преподавателей
app.get('/api/teachers', async (req, res) => {
    try {
        const { rows } = await sql`SELECT id, name, avatar FROM teachers`;
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Получить группы преподавателя (с количеством учеников)
app.get('/api/groups', async (req, res) => {
    const teacherId = req.query.teacher_id;
    if (!teacherId) return res.status(400).json({ error: 'teacher_id обязателен' });

    try {
        const { rows } = await sql`
            SELECT g.*, COUNT(gs.student_id) AS students_count
            FROM groups g
            LEFT JOIN group_students gs ON g.id = gs.group_id
            WHERE g.teacher_id = ${teacherId}
            GROUP BY g.id
        `;
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Получить детали группы (со списком учеников)
app.get('/api/groups/:id', async (req, res) => {
    const groupId = req.params.id;

    try {
        const groupResult = await sql`SELECT * FROM groups WHERE id = ${groupId}`;
        if (groupResult.rowCount === 0) {
            return res.status(404).json({ error: 'Группа не найдена' });
        }
        const group = groupResult.rows[0];

        const studentsResult = await sql`
            SELECT s.id, s.name, s.username, s.avatar, s.balance
            FROM students s
            JOIN group_students gs ON s.id = gs.student_id
            WHERE gs.group_id = ${groupId}
        `;
        group.students = studentsResult.rows;
        res.json(group);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Создать группу
app.post('/api/groups', async (req, res) => {
    const { title, teacher_id, day, time } = req.body;
    if (!title || !teacher_id) {
        return res.status(400).json({ error: 'title и teacher_id обязательны' });
    }

    try {
        const { rows } = await sql`
            INSERT INTO groups (title, teacher_id, day, time)
            VALUES (${title}, ${teacher_id}, ${day || null}, ${time || null})
            RETURNING id
        `;
        res.status(201).json({ id: rows[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Обновить группу
app.put('/api/groups/:id', async (req, res) => {
    const { title, day, time } = req.body;
    const groupId = req.params.id;

    try {
        const result = await sql`
            UPDATE groups
            SET title = ${title}, day = ${day}, time = ${time}
            WHERE id = ${groupId}
        `;
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Группа не найдена' });
        }
        res.json({ updated: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Удалить группу
app.delete('/api/groups/:id', async (req, res) => {
    const groupId = req.params.id;

    try {
        const result = await sql`DELETE FROM groups WHERE id = ${groupId}`;
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Группа не найдена' });
        }
        res.json({ deleted: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Добавить ученика в группу
app.post('/api/groups/:id/students', async (req, res) => {
    const groupId = req.params.id;
    const { student_id } = req.body;
    if (!student_id) return res.status(400).json({ error: 'student_id обязателен' });

    try {
        await sql`
            INSERT INTO group_students (group_id, student_id)
            VALUES (${groupId}, ${student_id})
            ON CONFLICT DO NOTHING
        `;
        res.status(201).json({ added: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Удалить ученика из группы
app.delete('/api/groups/:groupId/students/:studentId', async (req, res) => {
    const { groupId, studentId } = req.params;

    try {
        const result = await sql`
            DELETE FROM group_students
            WHERE group_id = ${groupId} AND student_id = ${studentId}
        `;
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Запись не найдена' });
        }
        res.json({ removed: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- ОБНОВЛЁННЫЙ ЭНДПОИНТ: Провести занятие с учётом присутствия ----------
app.post('/api/lessons', async (req, res) => {
    const { group_id, amount, date, present_student_ids } = req.body;
    if (!group_id || !amount || !date) {
        return res.status(400).json({ error: 'group_id, amount и date обязательны' });
    }

    try {
        await sql`BEGIN`;

        // Вставляем занятие
        const lessonResult = await sql`
            INSERT INTO lessons (group_id, date, amount)
            VALUES (${group_id}, ${date}, ${amount})
            RETURNING id
        `;
        const lessonId = lessonResult.rows[0].id;

        // Получаем список всех учеников группы
        const studentsResult = await sql`
            SELECT student_id FROM group_students WHERE group_id = ${group_id}
        `;
        const allStudentIds = studentsResult.rows.map(r => r.student_id);

        if (allStudentIds.length === 0) {
            await sql`COMMIT`;
            return res.json({ lessonId, message: 'В группе нет учеников' });
        }

        // Определяем множество присутствующих (если не передано, все присутствуют)
        const presentSet = new Set(present_student_ids || allStudentIds);

        for (const studentId of allStudentIds) {
            if (presentSet.has(studentId)) {
                // Присутствует: списываем сумму и создаём транзакцию
                await sql`
                    UPDATE students
                    SET balance = balance - ${amount}
                    WHERE id = ${studentId}
                `;
                await sql`
                    INSERT INTO transactions (student_id, amount, date, description, lesson_id)
                    VALUES (${studentId}, ${-amount}, ${date}, 'Списание за занятие', ${lessonId})
                `;
            } else {
                // Отсутствует: создаём отработку
                await sql`
                    INSERT INTO makeups (student_id, group_id, missed_date, original_lesson_id, status)
                    VALUES (${studentId}, ${group_id}, ${date}, ${lessonId}, 'pending')
                `;
            }
        }

        await sql`COMMIT`;
        res.json({ lessonId, message: 'Занятие проведено, отработки созданы для отсутствующих' });
    } catch (err) {
        await sql`ROLLBACK`;
        res.status(500).json({ error: err.message });
    }
});

// ---------- НОВЫЕ ЭНДПОИНТЫ ДЛЯ ОТРАБОТОК ----------

// Получить список отработок (с фильтром по преподавателю, статусу)
app.get('/api/makeups', async (req, res) => {
    const teacherId = req.query.teacher_id;
    const status = req.query.status;

    if (!teacherId) return res.status(400).json({ error: 'teacher_id обязателен' });

    try {
        let query = sql`
            SELECT m.*,
                   s.name AS student_name, s.username AS student_username, s.avatar AS student_avatar,
                   g.title AS group_title,
                   l.date AS lesson_date
            FROM makeups m
            JOIN students s ON m.student_id = s.id
            LEFT JOIN groups g ON m.group_id = g.id
            LEFT JOIN lessons l ON m.original_lesson_id = l.id
            WHERE g.teacher_id = ${teacherId}
        `;

        if (status) {
            query = sql`${query} AND m.status = ${status}`;
        }

        query = sql`${query} ORDER BY m.missed_date DESC`;

        const { rows } = await query;
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Создать отработку вручную
app.post('/api/makeups', async (req, res) => {
    const { student_id, group_id, missed_date, scheduled_date, description } = req.body;
    if (!student_id || !missed_date) {
        return res.status(400).json({ error: 'student_id и missed_date обязательны' });
    }

    try {
        const { rows } = await sql`
            INSERT INTO makeups (student_id, group_id, missed_date, scheduled_date, description, status)
            VALUES (${student_id}, ${group_id || null}, ${missed_date}, ${scheduled_date || null}, ${description || null}, 'pending')
            RETURNING id
        `;
        res.status(201).json({ id: rows[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Обновить отработку
app.put('/api/makeups/:id', async (req, res) => {
    const { id } = req.params;
    const { scheduled_date, status, description } = req.body;

    try {
        const result = await sql`
            UPDATE makeups
            SET scheduled_date = COALESCE(${scheduled_date}, scheduled_date),
                status = COALESCE(${status}, status),
                description = COALESCE(${description}, description)
            WHERE id = ${id}
        `;
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Отработка не найдена' });
        }
        res.json({ updated: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Удалить отработку
app.delete('/api/makeups/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await sql`DELETE FROM makeups WHERE id = ${id}`;
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Отработка не найдена' });
        }
        res.json({ deleted: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- НОВЫЙ ЭНДПОИНТ: Расписание ----------
app.get('/api/schedule', async (req, res) => {
    const teacherId = req.query.teacher_id;
    const startDate = req.query.start;
    const endDate = req.query.end;

    if (!teacherId || !startDate || !endDate) {
        return res.status(400).json({ error: 'teacher_id, start и end обязательны' });
    }

    try {
        // Получаем все группы преподавателя с днями недели
        const groupsResult = await sql`
            SELECT id, title, day, time FROM groups WHERE teacher_id = ${teacherId}
        `;
        const groups = groupsResult.rows;

        // Генерируем события для групп (повторяющиеся по дням недели)
        const groupEvents = [];
        const dayMap = { 'Вс':0,'Пн':1,'Вт':2,'Ср':3,'Чт':4,'Пт':5,'Сб':6 };
        const start = new Date(startDate);
        const end = new Date(endDate);
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
            const currentDay = d.getDay();
            groups.forEach(group => {
                if (group.day && dayMap[group.day] === currentDay) {
                    groupEvents.push({
                        id: `group-${group.id}-${d.toISOString().split('T')[0]}`,
                        type: 'group',
                        group_id: group.id,
                        title: group.title,
                        date: d.toISOString().split('T')[0],
                        time: group.time,
                        is_makeup: false,
                    });
                }
            });
        }

        // Получаем назначенные отработки
        const makeupsResult = await sql`
            SELECT m.id, m.scheduled_date, m.status, s.name AS student_name, g.title AS group_title
            FROM makeups m
            JOIN students s ON m.student_id = s.id
            LEFT JOIN groups g ON m.group_id = g.id
            WHERE g.teacher_id = ${teacherId}
              AND m.scheduled_date IS NOT NULL
              AND DATE(m.scheduled_date) BETWEEN ${startDate} AND ${endDate}
        `;
        const makeupEvents = makeupsResult.rows.map(m => ({
            id: `makeup-${m.id}`,
            type: 'makeup',
            makeup_id: m.id,
            title: `Отработка: ${m.student_name} ${m.group_title ? ' ('+m.group_title+')' : ''}`,
            date: m.scheduled_date.split('T')[0],
            time: m.scheduled_date.split('T')[1] ? m.scheduled_date.split('T')[1].substring(0,5) : null,
            status: m.status,
            is_makeup: true,
        }));

        // Объединяем и сортируем
        const allEvents = [...groupEvents, ...makeupEvents].sort((a,b) => a.date.localeCompare(b.date));
        res.json(allEvents);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- Остальные эндпоинты (без изменений) ----------

// Получить всех учеников (с фильтром по преподавателю)
app.get('/api/students', async (req, res) => {
    const teacherId = req.query.teacher_id;
    try {
        let rows;
        if (teacherId) {
            const result = await sql`
                SELECT DISTINCT s.*
                FROM students s
                JOIN group_students gs ON s.id = gs.student_id
                JOIN groups g ON gs.group_id = g.id
                WHERE g.teacher_id = ${teacherId}
            `;
            rows = result.rows;
        } else {
            const result = await sql`SELECT * FROM students`;
            rows = result.rows;
        }
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Получить транзакции ученика
app.get('/api/students/:id/transactions', async (req, res) => {
    const studentId = req.params.id;
    try {
        const { rows } = await sql`
            SELECT * FROM transactions
            WHERE student_id = ${studentId}
            ORDER BY date DESC
        `;
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Пополнить баланс ученика
app.post('/api/students/:id/transactions', async (req, res) => {
    const studentId = req.params.id;
    const { amount, description } = req.body;
    if (!amount) return res.status(400).json({ error: 'amount обязателен' });

    const date = new Date().toISOString().slice(0, 10);
    try {
        await sql`BEGIN`;

        await sql`
            UPDATE students
            SET balance = balance + ${amount}
            WHERE id = ${studentId}
        `;

        const transactionResult = await sql`
            INSERT INTO transactions (student_id, amount, date, description)
            VALUES (${studentId}, ${amount}, ${date}, ${description || 'Пополнение счета'})
            RETURNING id
        `;

        await sql`COMMIT`;
        res.status(201).json({ transactionId: transactionResult.rows[0].id });
    } catch (err) {
        await sql`ROLLBACK`;
        res.status(500).json({ error: err.message });
    }
});

// Получить одного ученика
app.get('/api/students/:id', async (req, res) => {
    const id = req.params.id;
    try {
        const { rows } = await sql`SELECT * FROM students WHERE id = ${id}`;
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Ученик не найден' });
        }
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Создать ученика
app.post('/api/students', async (req, res) => {
    const { name, username, avatar, balance } = req.body;
    if (!name || !username) {
        return res.status(400).json({ error: 'name и username обязательны' });
    }
    try {
        const { rows } = await sql`
            INSERT INTO students (name, username, avatar, balance)
            VALUES (${name}, ${username}, ${avatar || null}, ${balance || 0})
            RETURNING id
        `;
        res.status(201).json({ id: rows[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Обновить ученика
app.put('/api/students/:id', async (req, res) => {
    const { name, username, avatar, balance } = req.body;
    const id = req.params.id;
    try {
        const result = await sql`
            UPDATE students
            SET name = ${name}, username = ${username}, avatar = ${avatar}, balance = ${balance}
            WHERE id = ${id}
        `;
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Ученик не найден' });
        }
        res.json({ updated: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Удалить ученика
app.delete('/api/students/:id', async (req, res) => {
    const id = req.params.id;
    try {
        const result = await sql`DELETE FROM students WHERE id = ${id}`;
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Ученик не найден' });
        }
        res.json({ deleted: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Статистика преподавателя
app.get('/api/statistics', async (req, res) => {
    const teacherId = req.query.teacher_id;
    if (!teacherId) return res.status(400).json({ error: 'teacher_id обязателен' });

    try {
        const lessonsCountResult = await sql`
            SELECT COUNT(*) as count
            FROM lessons l
            JOIN groups g ON l.group_id = g.id
            WHERE g.teacher_id = ${teacherId}
        `;

        const totalEarnedResult = await sql`
            SELECT SUM(l.amount) as total
            FROM lessons l
            JOIN groups g ON l.group_id = g.id
            WHERE g.teacher_id = ${teacherId}
        `;

        const studentsCountResult = await sql`
            SELECT COUNT(DISTINCT s.id) as count
            FROM students s
            JOIN group_students gs ON s.id = gs.student_id
            JOIN groups g ON gs.group_id = g.id
            WHERE g.teacher_id = ${teacherId}
        `;

        const totalDebtResult = await sql`
            SELECT SUM(CASE WHEN s.balance < 0 THEN s.balance ELSE 0 END) as total
            FROM students s
            JOIN group_students gs ON s.id = gs.student_id
            JOIN groups g ON gs.group_id = g.id
            WHERE g.teacher_id = ${teacherId}
        `;

        res.json({
            lessonsCount: lessonsCountResult.rows[0]?.count || 0,
            totalEarned: totalEarnedResult.rows[0]?.total || 0,
            studentsCount: studentsCountResult.rows[0]?.count || 0,
            totalDebt: totalDebtResult.rows[0]?.total || 0
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Экспортируем для Vercel
module.exports = app;