# Implementación: cómo se entrega esta especificación

Dueño único del concepto **entrega**: el orden de lectura, el alcance de un
encargo, cuándo hay que parar, qué evidencia se exige y qué está prohibido.

[Índice](../README.md) · [Packets](packets/index.md) · [Migración](migration/index.md) · [Roadmap](../roadmap/index.md) · [Calidad](../quality/index.md) · [Decisiones](../decisions/index.md)

---

## 1. Prompt de arranque para el próximo coordinador

El prompt único y el reparto aprobado están en
[coordinación](../kickoff.md), con bloque copiable de kickoff en §6.
Kimi K3 dirige y gestiona commits; Opus implementa; Codex revisa cambios propios
de Kimi e hitos importantes. No mantener otra copia del prompt aquí.

La autorización de ejecutar la da el owner. Readiness tiene su único dueño en
[packets](packets/index.md); roles, consultas y continuidad en coordinación;
el protocolo de entrega y los límites de revisión siguen en esta página.

---

## 2. Cuándo parar

Un implementador **para y escala** —no decide— cuando aparece cualquiera de estas:

1. Una ruta necesaria falta en el write-set. Se propone la adición exacta; no se
   improvisa una ruta adicional.
2. El schema, la clave o la frontera transaccional no están decididos en
   [base de datos](../architecture/database/index.md).
3. Dos documentos de esta especificación se contradicen.
4. Un test que debería fallar no falla, o falla por una razón distinta de la que
   afirma medir.
5. Un objetivo numérico se incumple ([tests §9](../quality/testing/index.md)).
6. Hace falta gasto real o acceso a credenciales fuera del presupuesto/perfil ya
   autorizado, una instalación nueva no autorizada o acceso a otro repositorio.
7. Un defecto material aparece fuera del alcance del packet: se **registra** en
   [hallazgos](../findings/index.md) y no se arregla de paso.

La escalada va al coordinador; la decisión se registra en
[decisiones](../decisions/index.md) **antes** de continuar.

---

## 3. Evidencia y commit, por packet

| Etapa | Qué se produce |
| --- | --- |
| Apertura | prestate verificado: rama, HEAD, digests de autoridad, rutas del write-set |
| Cada paso atómico | checkpoint y comprobación de conformidad contra el write-set |
| Cierre técnico | diff completo, comandos ejecutados con sus códigos de salida, casos cubiertos y pruebas negativas |
| Verificación | un worker **distinto** ejecuta las comprobaciones y registra sus códigos de salida |
| Receipt | vincula tree, base, política y ambas identidades. **Inválido** si el verificador es el writer, si algún check salió distinto de cero, o si hay cambios fuera del write-set |
| Commit | lo autoriza el owner, o el coordinador en quien el owner haya delegado, dentro del alcance y los límites declarados. **Este documento no autoriza ningún commit** |

**No hace falta una confirmación humana por cada packet si el owner autorizó un
programa autónomo.** El owner puede delegar en el coordinador la apertura y el
cierre de packets dentro de un alcance y unos límites. Vuelve a hacer falta una
aprobación explícita cuando se amplía el alcance, se excede la cuota autorizada, se accede a
algo fuera de este repositorio, se publica, o cuando la ley del repositorio lo
exige. Esta ronda es **sólo documentación**; nada de lo anterior fabrica un permiso
hoy.

La prosa del writer no es evidencia. Lo que sostiene una afirmación es un comando
con su salida, un hash, o una línea de código citada.

---

## 4. Límites de auditoría

El esfuerzo de revisión está acotado a propósito, para que la revisión no se
convierta en su propio proyecto:

- packet mecánico y reversible: verificador automático más una auditoría posterior;
- packet semántico: una auditoría previa del brief y una posterior;
- packet de arquitectura, leases, credenciales, Git o recuperación: auditoría
  previa y posterior, más una revisión de consultor en el checkpoint de fase;
- tras un rechazo, el coordinador adjudica **una** corrección concreta.

**No se piden versiones sucesivas del mismo contrato sin código nuevo, y no se
abre una cadena de reauditorías por cada cambio pequeño.**

---

## 5. Qué no forma parte de esta implementación

- **Interfaz visual y shell de escritorio.** El diseño va primero y lo acepta el
  owner; la matriz de accesibilidad es un gate previo al release con interfaz.
- **P9 y adopción en un repositorio de producto.** Requieren autorización separada
  del owner y un perfil demostrado.
- **Cualquier otro repositorio, sesión de terminal o worktree existente.**
- **Publicación.** Ninguna entrega de esta secuencia la habilita.
- **Instalaciones pesadas, proveedores reales y gasto** sin una decisión explícita
  con límite de consumo.

---

## 6. Estado de esta especificación

- Es una **propuesta de especificación autorizada por el owner**, no una admisión
  automática en tiempo de ejecución. Mientras el puente de
  [migración](migration/index.md) no se cierre, la autoridad operativa del
  repositorio sigue siendo la que declaran `AGENTS.md` y el roadmap vigente.
- **El diseño no autoriza ejecución.** Los contratos y decisiones se especifican
  en sus documentos dueños. Cada apertura requiere fijar las rutas contra su HEAD,
  verificar dependencias y obtener autorización dentro de un programa delegado.
  Si aparece un hueco material, el packet pierde `DESIGN_READY` hasta adjudicarlo;
  no se disfraza de una mera congelación de rutas.
- Los documentos de esta carpeta **no** están admitidos todavía por la lista exacta
  de rutas de la compuerta de arquitectura, y **no se modificó el checker para
  autoaprobarlos**.
