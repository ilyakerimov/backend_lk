const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(bodyParser.json());

// Путь к файлу базы данных
const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Ошибка подключения к БД:', err.message);
    } else {
        console.log('Подключено к SQLite.');
        initDatabase();
    }
});

// Инициализация таблиц и начальных данных
function initDatabase() {
    db.serialize(() => {
        // Создание таблиц
        db.run(`CREATE TABLE IF NOT EXISTS teachers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            avatar TEXT
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS students (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            username TEXT UNIQUE,
            avatar TEXT,
            balance INTEGER DEFAULT 0
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            teacher_id INTEGER NOT NULL,
            day TEXT,
            time TEXT,
            FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS group_students (
            group_id INTEGER NOT NULL,
            student_id INTEGER NOT NULL,
            PRIMARY KEY (group_id, student_id),
            FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
            FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS lessons (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL,
            date TEXT NOT NULL,
            amount INTEGER NOT NULL,
            FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL,
            amount INTEGER NOT NULL,
            date TEXT NOT NULL,
            description TEXT,
            lesson_id INTEGER,
            FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
            FOREIGN KEY (lesson_id) REFERENCES lessons(id) ON DELETE SET NULL
        )`);

        // Проверка наличия начальных данных
        db.get("SELECT COUNT(*) AS count FROM teachers", (err, row) => {
            if (err) {
                console.error(err);
            } else if (row.count === 0) {
                console.log('Заполнение базы начальными данными...');
                // Преподаватели
                db.run(`INSERT INTO teachers (name, avatar) VALUES 
                    ('Илья Керимов', '/images/ilya.jpg'),
                    ('Альбина Иванова', '/images/alina.jpg')`);

                // Ученики
                db.run(`INSERT INTO students (name, username, avatar, balance) VALUES 
                    ('Иван Петров', '@ivan', NULL, 5000),
                    ('Мария Смирнова', '@maria', NULL, 3000),
                    ('Алексей Сидоров', '@alex', NULL, 2000),
                    ('Елена Васильева', '@elena', NULL, 4500),
                    ('Дмитрий Козлов', '@dmitry', NULL, 6000)`);

                // Группы
                db.run(`INSERT INTO groups (title, teacher_id, day, time) VALUES 
                    ('Группа A', 1, 'Сб', '10:00 – 11:30'),
                    ('Группа Б', 1, 'Вт', '12:00 – 13:30'),
                    ('Группа В', 2, 'Чт', '15:00 – 16:30'),
                    ('Группа Г', 2, 'Пн', '17:00 – 18:30')`);

                // Связи групп и учеников
                db.run(`INSERT INTO group_students (group_id, student_id) VALUES 
                    (1, 1), (1, 2), (1, 4),
                    (2, 3), (2, 5),
                    (3, 1), (3, 3), (3, 4),
                    (4, 2), (4, 5)`);
            }
        });
    });
}

// -------------------- API --------------------

// Получить список преподавателей
app.get('/api/teachers', (req, res) => {
    db.all('SELECT id, name, avatar FROM teachers', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Получить группы преподавателя (с количеством учеников)
app.get('/api/groups', (req, res) => {
    const teacherId = req.query.teacher_id;
    if (!teacherId) return res.status(400).json({ error: 'teacher_id обязателен' });

    db.all(`
        SELECT g.*, COUNT(gs.student_id) AS students_count
        FROM groups g
        LEFT JOIN group_students gs ON g.id = gs.group_id
        WHERE g.teacher_id = ?
        GROUP BY g.id
    `, [teacherId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Получить детали группы (со списком учеников)
app.get('/api/groups/:id', (req, res) => {
    const groupId = req.params.id;

    db.get('SELECT * FROM groups WHERE id = ?', [groupId], (err, group) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!group) return res.status(404).json({ error: 'Группа не найдена' });

        db.all(`
            SELECT s.id, s.name, s.username, s.avatar, s.balance
            FROM students s
            JOIN group_students gs ON s.id = gs.student_id
            WHERE gs.group_id = ?
        `, [groupId], (err, students) => {
            if (err) return res.status(500).json({ error: err.message });
            group.students = students;
            res.json(group);
        });
    });
});

// Создать группу
app.post('/api/groups', (req, res) => {
    const { title, teacher_id, day, time } = req.body;
    if (!title || !teacher_id) {
        return res.status(400).json({ error: 'title и teacher_id обязательны' });
    }

    db.run(
        'INSERT INTO groups (title, teacher_id, day, time) VALUES (?, ?, ?, ?)',
        [title, teacher_id, day || null, time || null],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.status(201).json({ id: this.lastID });
        }
    );
});

// Обновить группу
app.put('/api/groups/:id', (req, res) => {
    const { title, day, time } = req.body;
    const groupId = req.params.id;

    db.run(
        'UPDATE groups SET title = ?, day = ?, time = ? WHERE id = ?',
        [title, day, time, groupId],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: 'Группа не найдена' });
            res.json({ updated: true });
        }
    );
});

// Удалить группу
app.delete('/api/groups/:id', (req, res) => {
    const groupId = req.params.id;

    db.run('DELETE FROM groups WHERE id = ?', groupId, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Группа не найдена' });
        res.json({ deleted: true });
    });
});

// Добавить ученика в группу
app.post('/api/groups/:id/students', (req, res) => {
    const groupId = req.params.id;
    const { student_id } = req.body;
    if (!student_id) return res.status(400).json({ error: 'student_id обязателен' });

    db.run(
        'INSERT OR IGNORE INTO group_students (group_id, student_id) VALUES (?, ?)',
        [groupId, student_id],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.status(201).json({ added: this.changes > 0 });
        }
    );
});

// Удалить ученика из группы
app.delete('/api/groups/:groupId/students/:studentId', (req, res) => {
    const { groupId, studentId } = req.params;

    db.run(
        'DELETE FROM group_students WHERE group_id = ? AND student_id = ?',
        [groupId, studentId],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: 'Запись не найдена' });
            res.json({ removed: true });
        }
    );
});

// Провести занятие
app.post('/api/lessons', (req, res) => {
    const { group_id, amount, date } = req.body;
    if (!group_id || !amount || !date) {
        return res.status(400).json({ error: 'group_id, amount и date обязательны' });
    }

    db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        db.run(
            'INSERT INTO lessons (group_id, date, amount) VALUES (?, ?, ?)',
            [group_id, date, amount],
            function(err) {
                if (err) {
                    db.run('ROLLBACK');
                    return res.status(500).json({ error: err.message });
                }
                const lessonId = this.lastID;

                db.all(
                    'SELECT student_id FROM group_students WHERE group_id = ?',
                    [group_id],
                    (err, rows) => {
                        if (err) {
                            db.run('ROLLBACK');
                            return res.status(500).json({ error: err.message });
                        }

                        const studentIds = rows.map(r => r.student_id);
                        if (studentIds.length === 0) {
                            db.run('COMMIT');
                            return res.json({ lessonId, message: 'В группе нет учеников' });
                        }

                        let completed = 0;
                        studentIds.forEach(studentId => {
                            db.run(
                                'UPDATE students SET balance = balance - ? WHERE id = ?',
                                [amount, studentId],
                                function(err) {
                                    if (err) {
                                        db.run('ROLLBACK');
                                        return res.status(500).json({ error: err.message });
                                    }

                                    db.run(
                                        `INSERT INTO transactions (student_id, amount, date, description, lesson_id)
                                         VALUES (?, ?, ?, ?, ?)`,
                                        [studentId, -amount, date, `Списание за занятие`, lessonId],
                                        function(err) {
                                            if (err) {
                                                db.run('ROLLBACK');
                                                return res.status(500).json({ error: err.message });
                                            }

                                            completed++;
                                            if (completed === studentIds.length) {
                                                db.run('COMMIT');
                                                res.json({ lessonId, message: 'Занятие проведено' });
                                            }
                                        }
                                    );
                                }
                            );
                        });
                    }
                );
            }
        );
    });
});

// Получить всех учеников (с фильтром по преподавателю через группы)
app.get('/api/students', (req, res) => {
    const teacherId = req.query.teacher_id;
    let query = `SELECT DISTINCT s.* FROM students s`;
    let params = [];
    if (teacherId) {
        query = `
            SELECT DISTINCT s.*
            FROM students s
            JOIN group_students gs ON s.id = gs.student_id
            JOIN groups g ON gs.group_id = g.id
            WHERE g.teacher_id = ?
        `;
        params = [teacherId];
    }

    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Получить транзакции ученика
app.get('/api/students/:id/transactions', (req, res) => {
    const studentId = req.params.id;
    db.all(
        'SELECT * FROM transactions WHERE student_id = ? ORDER BY date DESC',
        [studentId],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        }
    );
});

// Пополнить баланс ученика
app.post('/api/students/:id/transactions', (req, res) => {
    const studentId = req.params.id;
    const { amount, description } = req.body;
    if (!amount) return res.status(400).json({ error: 'amount обязателен' });

    const date = new Date().toISOString().slice(0, 10);
    db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        db.run(
            'UPDATE students SET balance = balance + ? WHERE id = ?',
            [amount, studentId],
            function(err) {
                if (err) {
                    db.run('ROLLBACK');
                    return res.status(500).json({ error: err.message });
                }
                db.run(
                    'INSERT INTO transactions (student_id, amount, date, description) VALUES (?, ?, ?, ?)',
                    [studentId, amount, date, description || 'Пополнение счета'],
                    function(err) {
                        if (err) {
                            db.run('ROLLBACK');
                            return res.status(500).json({ error: err.message });
                        }
                        db.run('COMMIT');
                        res.status(201).json({ transactionId: this.lastID });
                    }
                );
            }
        );
    });
});

// Получить одного ученика
app.get('/api/students/:id', (req, res) => {
    const id = req.params.id;
    db.get('SELECT * FROM students WHERE id = ?', [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Ученик не найден' });
        res.json(row);
    });
});

// Создать ученика
app.post('/api/students', (req, res) => {
    const { name, username, avatar, balance } = req.body;
    if (!name || !username) {
        return res.status(400).json({ error: 'name и username обязательны' });
    }
    db.run(
        'INSERT INTO students (name, username, avatar, balance) VALUES (?, ?, ?, ?)',
        [name, username, avatar || null, balance || 0],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.status(201).json({ id: this.lastID });
        }
    );
});

// Обновить ученика
app.put('/api/students/:id', (req, res) => {
    const { name, username, avatar, balance } = req.body;
    const id = req.params.id;
    db.run(
        'UPDATE students SET name = ?, username = ?, avatar = ?, balance = ? WHERE id = ?',
        [name, username, avatar, balance, id],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: 'Ученик не найден' });
            res.json({ updated: true });
        }
    );
});

// Удалить ученика
app.delete('/api/students/:id', (req, res) => {
    const id = req.params.id;
    db.run('DELETE FROM students WHERE id = ?', id, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Ученик не найден' });
        res.json({ deleted: true });
    });
});

// ---------- НОВЫЙ ЭНДПОИНТ: СТАТИСТИКА ПРЕПОДАВАТЕЛЯ ----------
app.get('/api/statistics', (req, res) => {
    const teacherId = req.query.teacher_id;
    if (!teacherId) return res.status(400).json({ error: 'teacher_id обязателен' });

    db.serialize(() => {
        // Количество занятий
        db.get(`
            SELECT COUNT(*) as lessonsCount
            FROM lessons l
            JOIN groups g ON l.group_id = g.id
            WHERE g.teacher_id = ?
        `, [teacherId], (err, lessonsRow) => {
            if (err) return res.status(500).json({ error: err.message });

            // Заработанная сумма (сумма всех списаний за уроки)
            db.get(`
                SELECT SUM(l.amount) as totalEarned
                FROM lessons l
                JOIN groups g ON l.group_id = g.id
                WHERE g.teacher_id = ?
            `, [teacherId], (err, earnedRow) => {
                if (err) return res.status(500).json({ error: err.message });

                // Количество учеников (уникальных)
                db.get(`
                    SELECT COUNT(DISTINCT s.id) as studentsCount
                    FROM students s
                    JOIN group_students gs ON s.id = gs.student_id
                    JOIN groups g ON gs.group_id = g.id
                    WHERE g.teacher_id = ?
                `, [teacherId], (err, studentsRow) => {
                    if (err) return res.status(500).json({ error: err.message });

                    // Сумма долга (отрицательный баланс)
                    db.get(`
                        SELECT SUM(CASE WHEN s.balance < 0 THEN s.balance ELSE 0 END) as totalDebt
                        FROM students s
                        JOIN group_students gs ON s.id = gs.student_id
                        JOIN groups g ON gs.group_id = g.id
                        WHERE g.teacher_id = ?
                    `, [teacherId], (err, debtRow) => {
                        if (err) return res.status(500).json({ error: err.message });

                        res.json({
                            lessonsCount: lessonsRow.lessonsCount || 0,
                            totalEarned: earnedRow.totalEarned || 0,
                            studentsCount: studentsRow.studentsCount || 0,
                            totalDebt: debtRow.totalDebt || 0
                        });
                    });
                });
            });
        });
    });
});

app.listen(PORT, () => {
    console.log(`Сервер запущен на http://localhost:${PORT}`);
});