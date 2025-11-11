// 💡 CORRECCIÓN: Usamos la sintaxis CommonJS (require) para evitar el error.
const express = require('express');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
// Usamos bcryptjs para la compatibilidad con CommonJS. Asegúrate de instalarlo.
const bcrypt = require('bcryptjs');

dotenv.config(); // Carga las variables del .env

const app = express();
const port = process.env.API_PORT || 3000;

app.use(express.json());

// =======================================================
// 1. CONFIGURACIÓN DE LA CONEXIÓN A LA BASE DE DATOS
// =======================================================
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
});

// Mensaje de prueba de la API
app.get('/', (req, res) => {
    res.status(200).json({ message: `API EcoDuino está funcionando en puerto ${port}.` });
});

// =======================================================
// 2. RUTA DE AUTENTICACIÓN (USADA POR LA APP MÓVIL)
// =======================================================

// 2.1. INICIO DE SESIÓN (LOGIN)
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Correo y contraseña son requeridos.' });
    }

    try {
        const [users] = await pool.query('SELECT id_usuario, password_hash FROM usuarios WHERE email = ?', [email]);

        if (users.length === 0) {
            return res.status(401).json({ error: 'Credenciales inválidas.' });
        }

        const user = users[0];

        // 💡 Lógica Real de Seguridad: Compara la contraseña usando bcrypt.
        const isMatch = await bcrypt.compare(password, user.password_hash);

        if (!isMatch) {
            return res.status(401).json({ error: 'Credenciales inválidas.' });
        }

        // Generar y devolver un token de sesión (JWT) aquí
        res.status(200).json({
            message: 'Inicio de sesión exitoso.',
            userId: user.id_usuario,
            token: 'fake-jwt-token-' + user.id_usuario,
        });
    } catch (error) {
        console.error('❌ Error en la base de datos durante el login:', error.message);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// 2.2. REGISTRO DE NUEVO USUARIO
app.post('/api/auth/register', async (req, res) => {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
        return res.status(400).json({ message: 'Todos los campos (nombre, correo, contraseña) son requeridos.' });
    }

    try {
        const [existingUsers] = await pool.query('SELECT id_usuario FROM usuarios WHERE email = ?', [email]);

        if (existingUsers.length > 0) {
            return res.status(409).json({ message: 'El correo electrónico ya está registrado.' });
        }

        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        const sql = `
            INSERT INTO usuarios (nombre, email, password_hash)
            VALUES (?, ?, ?)
        `;
        const [result] = await pool.query(sql, [name, email, passwordHash]);
        const newUserId = result.insertId;

        console.log(`[${new Date().toLocaleTimeString()}] ✅ Nuevo usuario registrado: ID #${newUserId}`);

        res.status(201).json({
            message: 'Usuario registrado exitosamente. Por favor, inicie sesión.',
            userId: newUserId,
        });
    } catch (error) {
        console.error('❌ Error en la base de datos durante el registro:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al registrar el usuario.' });
    }
});

// 2.3. CREACIÓN DE INVERNADERO
app.post('/api/invernaderos/crear', async (req, res) => {
    const { userId, nombreUbicacion, tokenDispositivo } = req.body;
    let connection;

    if (!userId || !nombreUbicacion || !tokenDispositivo) {
        return res.status(400).json({ message: 'Datos incompletos: userId, nombreUbicacion y tokenDispositivo son requeridos.' });
    }

    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const [existingInv] = await connection.query(
            'SELECT id_invernadero FROM invernadero WHERE token_dispositivo = ?',
            [tokenDispositivo]
        );

        if (existingInv.length > 0) {
            await connection.rollback();
            return res.status(409).json({ message: 'El token del dispositivo ya está asignado a otro invernadero.' });
        }

        const [invResult] = await connection.query(
            'INSERT INTO invernadero (nombre_ubicacion, token_dispositivo, ultima_conexion) VALUES (?, ?, NOW())',
            [nombreUbicacion, tokenDispositivo]
        );
        const newInvId = invResult.insertId;

        await connection.query(
            'INSERT INTO estado_control (id_invernadero, luces_estado, riego_estado, ventilacion_estado) VALUES (?, 0, 0, 0)',
            [newInvId]
        );

        await connection.query(
            'INSERT INTO usuario_invernadero (id_usuario, id_invernadero, rol) VALUES (?, ?, ?)',
            [userId, newInvId, 'admin']
        );

        await connection.commit();

        console.log(`[${new Date().toLocaleTimeString()}] ✅ Invernadero #${newInvId} creado y asignado al usuario #${userId}.`);

        res.status(201).json({
            message: 'Invernadero creado y asignado con éxito.',
            invernaderoId: newInvId,
        });
    } catch (error) {
        if (connection) await connection.rollback();
        console.error('❌ Error durante la creación del invernadero:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al crear el invernadero.' });
    } finally {
        if (connection) connection.release();
    }
});

// =======================================================
// 2.4. OBTENER LISTA DE INVERNADEROS POR USUARIO 🚩 CORRECCIÓN: Nombres de columna originales
// =======================================================
app.get('/api/invernaderos/user/:userId', async (req, res) => {
    const userId = req.params.userId;
    if (!userId) {
        return res.status(400).json({ error: 'El ID del usuario es requerido.' });
    }

    try {
        // 🚨 CORRECCIÓN CLAVE: Devolvemos los nombres de las columnas de la BD 
        // para que coincida con Zona.fromJson(json['id_invernadero'], json['nombre_ubicacion'])
        const sql = `
            SELECT 
                I.id_invernadero, 
                I.nombre_ubicacion,
                I.token_dispositivo,
                I.ultima_conexion
            FROM invernadero I
            JOIN usuario_invernadero UI ON I.id_invernadero = UI.id_invernadero
            WHERE UI.id_usuario = ?
            ORDER BY I.id_invernadero ASC
        `;
        const [invernaderos] = await pool.query(sql, [userId]);

        console.log(`[${new Date().toLocaleTimeString()}] 🔍 Invernaderos consultados para el usuario #${userId}: ${invernaderos.length} resultados.`);

        // Si no hay invernaderos, devuelve una lista vacía con status 200 (OK).
        res.status(200).json(invernaderos);
    } catch (error) {
        console.error('❌ Error al obtener la lista de invernaderos por usuario:', error.message);
        res.status(500).json({ error: 'Error interno del servidor al consultar la base de datos.' });
    }
});


// =======================================================
// 3. INGRESO DE DATOS (ESP32)
// =======================================================
app.post('/api/data/ingresar', async (req, res) => {
    const { token, tempAmbiente, humAmbiente, humedadSuelo } = req.body;

    if (!token || humedadSuelo === undefined || tempAmbiente === undefined || humAmbiente === undefined) {
        return res.status(400).json({ error: 'Datos incompletos o inválidos.' });
    }

    try {
        const [invernaderos] = await pool.query(
            'SELECT id_invernadero FROM invernadero WHERE token_dispositivo = ?',
            [token]
        );

        if (invernaderos.length === 0) {
            return res.status(401).json({ error: 'Token de dispositivo no autorizado.' });
        }

        const id_invernadero = invernaderos[0].id_invernadero;

        const sql = `
            INSERT INTO registro_sensores 
            (id_invernadero, fecha_hora, temp_ambiente, humedad_ambiente, humedad_suelo) 
            VALUES 
            (?, NOW(), ?, ?, ?)
        `;

        await pool.query(sql, [
            id_invernadero,
            Number(tempAmbiente),
            Number(humAmbiente),
            Number(humedadSuelo),
        ]);

        await pool.query('UPDATE invernadero SET ultima_conexion = NOW() WHERE id_invernadero = ?', [id_invernadero]);

        console.log(`[${new Date().toLocaleTimeString()}] ✔️ Lectura registrada para INV #${id_invernadero}`);
        res.status(201).json({ message: 'Datos recibidos y guardados correctamente.' });
    } catch (error) {
        console.error('❌ Error al ingresar datos:', error.message);
        res.status(500).json({ error: 'Error interno del servidor.', details: error.message });
    }
});

// =======================================================
// 4. CONSULTAS DE DATOS
// =======================================================
app.get('/api/data/ultima/:id_inv', async (req, res) => {
    const id_invernadero = req.params.id_inv;
    try {
        const sql = `
            SELECT temp_ambiente, humedad_ambiente, humedad_suelo, fecha_hora
            FROM registro_sensores 
            WHERE id_invernadero = ? 
            ORDER BY fecha_hora DESC 
            LIMIT 1
        `;
        const [registro] = await pool.query(sql, [id_invernadero]);

        if (registro.length === 0) {
            return res.status(404).json({ message: 'No se encontraron datos para este invernadero.' });
        }
        res.status(200).json(registro[0]);
    } catch (error) {
        console.error('❌ Error al obtener el último registro:', error.message);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

app.get('/api/data/historico/:id_inv', async (req, res) => {
    const id_invernadero = req.params.id_inv;
    const limit = req.query.limit ? parseInt(req.query.limit) : 50;
    try {
        const sql = `
            SELECT fecha_hora, temp_ambiente, humedad_ambiente, humedad_suelo 
            FROM registro_sensores 
            WHERE id_invernadero = ? 
            ORDER BY fecha_hora DESC 
            LIMIT ?
        `;
        const [registros] = await pool.query(sql, [id_invernadero, limit]);

        if (registros.length === 0) {
            return res.status(404).json({ message: 'No se encontraron datos históricos.' });
        }
        res.status(200).json(registros);
    } catch (error) {
        console.error('❌ Error al obtener datos históricos:', error.message);
        res.status(500).json({ error: 'Error interno del servidor al consultar la base de datos.' });
    }
});

// =======================================================
// 5. CONTROL DE ACTUADORES
// =======================================================
app.get('/api/control/estado/:token', async (req, res) => {
    const token = req.params.token;

    try {
        const [invernaderos] = await pool.query(
            'SELECT id_invernadero FROM invernadero WHERE token_dispositivo = ?',
            [token]
        );

        if (invernaderos.length === 0) {
            return res.status(401).json({ error: 'Token de dispositivo no encontrado.' });
        }

        const id_invernadero = invernaderos[0].id_invernadero;

        const [estado] = await pool.query(
            'SELECT luces_estado, riego_estado, ventilacion_estado FROM estado_control WHERE id_invernadero = ?',
            [id_invernadero]
        );

        if (estado.length === 0) {
            return res.status(404).json({ error: 'Estado de control no inicializado.' });
        }

        res.status(200).json({
            luces: !!estado[0].luces_estado,
            riego: !!estado[0].riego_estado,
            ventilacion: !!estado[0].ventilacion_estado,
        });
    } catch (error) {
        console.error('❌ Error al obtener estado de control:', error.message);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

app.put('/api/control/actualizar/:id_inv', async (req, res) => {
    const id_invernadero = req.params.id_inv;
    const { actuador, estado } = req.body;

    if (!actuador || estado === undefined) {
        return res.status(400).json({ error: 'Actuador o estado no especificado.' });
    }

    const actuadorCampo = {
        luces: 'luces_estado',
        riego: 'riego_estado',
        ventilacion: 'ventilacion_estado',
    }[actuador];

    if (!actuadorCampo) {
        return res.status(400).json({ error: 'Actuador inválido.' });
    }

    try {
        const sql = `
            UPDATE ESTADO_CONTROL 
            SET ${actuadorCampo} = ?, ultima_actualizacion = NOW() 
            WHERE id_invernadero = ?
        `;

        await pool.query(sql, [estado, id_invernadero]);

        res.status(200).json({ message: `Estado de ${actuador} actualizado a ${estado}.` });
    } catch (error) {
        console.error('❌ Error al actualizar el control:', error.message);
        res.status(500).json({ error: 'Error al actualizar el estado de control.' });
    }
});

// =======================================================
// 6. INICIO DEL SERVIDOR
// =======================================================
app.listen(port, '0.0.0.0', () => {
    console.log(`API Node.js escuchando en http://0.0.0.0:${port}`);
    console.log(`Conectado a MySQL: ${process.env.DB_NAME}`);

});
