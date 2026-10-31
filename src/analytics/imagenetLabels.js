/**
 * imagenetLabels.js — Nombres en español de las 1000 clases de ImageNet, en
 * el MISMO ORDEN que las etiquetas del modelo EfficientNet-Lite0 de MediaPipe
 * (labels_without_background.txt, índices 0–999). La prueba unitaria
 * comprueba que hay exactamente 1000.
 *
 * Además, IMAGENET_TO_COCO agrupa clases finas en categorías COCO (razas de
 * perro → «perro», gatos → «gato», aves → «pájaro», vehículos…) para que el
 * clasificador pueda corregir la etiqueta del detector de objetos.
 */

export const IMAGENET_ES = [
  // 0–11
  'tenca', 'pez dorado', 'tiburón blanco', 'tiburón tigre', 'pez martillo', 'raya eléctrica', 'pastinaca', 'gallo', 'gallina', 'avestruz', 'pinzón real', 'jilguero',
  // 12–23
  'camachuelo mexicano', 'junco (ave)', 'azulillo índigo', 'petirrojo americano', 'bulbul', 'arrendajo', 'urraca', 'carbonero', 'mirlo acuático', 'milano', 'águila calva', 'buitre',
  // 24–35
  'cárabo lapón', 'salamandra común', 'tritón común', 'tritón juvenil', 'salamandra moteada', 'ajolote', 'rana toro', 'rana arborícola', 'rana de cola', 'tortuga boba', 'tortuga laúd', 'tortuga de barro',
  // 36–47
  'galápago', 'tortuga de caja', 'geco bandeado', 'iguana común', 'anolis verde', 'lagartija cola de látigo', 'agama', 'lagarto de gorguera', 'lagarto caimán', 'monstruo de Gila', 'lagarto verde', 'camaleón africano',
  // 48–59
  'dragón de Komodo', 'cocodrilo africano', 'caimán americano', 'triceratops', 'serpiente del trueno', 'culebra de collar', 'culebra de nariz de cerdo', 'culebra verde', 'serpiente real', 'culebra de jarretera', 'culebra de agua', 'culebra liana',
  // 60–71
  'culebra nocturna', 'boa constrictor', 'pitón de roca', 'cobra india', 'mamba verde', 'serpiente marina', 'víbora cornuda', 'serpiente de cascabel diamantina', 'crótalo cornudo', 'trilobites', 'opilión', 'escorpión',
  // 72–83
  'araña de jardín amarilla', 'araña de granero', 'araña de jardín', 'viuda negra', 'tarántula', 'araña lobo', 'garrapata', 'ciempiés', 'gallo lira', 'lagópodo', 'grévol engolado', 'gallo de las praderas',
  // 84–95
  'pavo real', 'codorniz', 'perdiz', 'loro gris africano', 'guacamayo', 'cacatúa galerita', 'lori', 'cucal', 'abejaruco', 'cálao', 'colibrí', 'jacamar',
  // 96–107
  'tucán', 'pato macho', 'serreta mediana', 'ganso', 'cisne negro', 'elefante colmilludo', 'equidna', 'ornitorrinco', 'ualabí', 'koala', 'wombat', 'medusa',
  // 108–119
  'anémona de mar', 'coral cerebro', 'gusano plano', 'nematodo', 'caracola', 'caracol', 'babosa', 'babosa marina', 'quitón', 'nautilo', 'cangrejo Dungeness', 'cangrejo de roca',
  // 120–131
  'cangrejo violinista', 'centolla real', 'bogavante americano', 'langosta', 'cangrejo de río', 'cangrejo ermitaño', 'isópodo', 'cigüeña blanca', 'cigüeña negra', 'espátula (ave)', 'flamenco', 'garceta azul',
  // 132–143
  'garceta grande', 'avetoro', 'grulla', 'carrao', 'calamón', 'focha americana', 'avutarda', 'vuelvepiedras', 'correlimos común', 'archibebe', 'agujeta', 'ostrero',
  // 144–155
  'pelícano', 'pingüino rey', 'albatros', 'ballena gris', 'orca', 'dugongo', 'león marino', 'chihuahua', 'spaniel japonés', 'maltés', 'pequinés', 'shih tzu',
  // 156–167
  'spaniel Blenheim', 'papillón', 'toy terrier', 'crestado rodesiano', 'galgo afgano', 'basset hound', 'beagle', 'sabueso de San Huberto', 'bluetick coonhound', 'coonhound negro y fuego', 'walker hound', 'foxhound inglés',
  // 168–179
  'redbone coonhound', 'borzoi', 'lebrel irlandés', 'galgo italiano', 'whippet', 'podenco ibicenco', 'cazador de alces noruego', 'otterhound', 'saluki', 'lebrel escocés', 'braco de Weimar', 'staffordshire bull terrier',
  // 180–191
  'american staffordshire terrier', 'bedlington terrier', 'border terrier', 'kerry blue terrier', 'terrier irlandés', 'norfolk terrier', 'norwich terrier', 'yorkshire terrier', 'fox terrier de pelo duro', 'lakeland terrier', 'sealyham terrier', 'airedale terrier',
  // 192–203
  'cairn terrier', 'terrier australiano', 'dandie dinmont', 'boston terrier', 'schnauzer miniatura', 'schnauzer gigante', 'schnauzer estándar', 'terrier escocés', 'terrier tibetano', 'silky terrier', 'terrier irlandés de pelo suave', 'west highland white terrier',
  // 204–215
  'lhasa apso', 'retriever de pelo liso', 'retriever de pelo rizado', 'golden retriever', 'labrador retriever', 'retriever de Chesapeake', 'braco alemán de pelo corto', 'vizsla', 'setter inglés', 'setter irlandés', 'setter Gordon', 'spaniel bretón',
  // 216–227
  'clumber spaniel', 'springer spaniel inglés', 'springer spaniel galés', 'cocker spaniel', 'sussex spaniel', 'spaniel de agua irlandés', 'kuvasz', 'schipperke', 'pastor belga groenendael', 'pastor belga malinois', 'pastor de Brie', 'kelpie australiano',
  // 228–239
  'komondor', 'antiguo pastor inglés', 'pastor de Shetland', 'collie', 'border collie', 'boyero de Flandes', 'rottweiler', 'pastor alemán', 'dóberman', 'pinscher miniatura', 'gran boyero suizo', 'boyero de Berna',
  // 240–251
  'boyero de Appenzell', 'boyero de Entlebuch', 'bóxer', 'bullmastiff', 'mastín tibetano', 'bulldog francés', 'gran danés', 'san bernardo', 'perro esquimal', 'malamute', 'husky siberiano', 'dálmata',
  // 252–263
  'affenpinscher', 'basenji', 'carlino', 'leonberger', 'terranova', 'montaña de los Pirineos', 'samoyedo', 'pomerania', 'chow chow', 'keeshond', 'grifón de Bruselas', 'corgi Pembroke',
  // 264–275
  'corgi Cardigan', 'caniche toy', 'caniche miniatura', 'caniche estándar', 'perro sin pelo mexicano', 'lobo gris', 'lobo blanco', 'lobo rojo', 'coyote', 'dingo', 'cuón', 'licaón',
  // 276–287
  'hiena', 'zorro rojo', 'zorro veloz', 'zorro ártico', 'zorro gris', 'gato atigrado', 'gato tigre', 'gato persa', 'gato siamés', 'gato egipcio', 'puma', 'lince',
  // 288–299
  'leopardo', 'leopardo de las nieves', 'jaguar', 'león', 'tigre', 'guepardo', 'oso pardo', 'oso negro americano', 'oso polar', 'oso perezoso', 'mangosta', 'suricata',
  // 300–311
  'escarabajo tigre', 'mariquita', 'escarabajo de tierra', 'escarabajo longicornio', 'escarabajo de las hojas', 'escarabajo pelotero', 'escarabajo rinoceronte', 'gorgojo', 'mosca', 'abeja', 'hormiga', 'saltamontes',
  // 312–323
  'grillo', 'insecto palo', 'cucaracha', 'mantis', 'cigarra', 'chicharrita', 'crisopa', 'libélula', 'caballito del diablo', 'mariposa almirante', 'mariposa ringlet', 'mariposa monarca',
  // 324–335
  'mariposa de la col', 'mariposa azufre', 'licénido', 'estrella de mar', 'erizo de mar', 'pepino de mar', 'conejo de monte', 'liebre', 'conejo angora', 'hámster', 'puercoespín', 'ardilla zorro',
  // 336–347
  'marmota', 'castor', 'cobaya', 'caballo alazán', 'cebra', 'cerdo', 'jabalí', 'facóquero', 'hipopótamo', 'buey', 'búfalo de agua', 'bisonte',
  // 348–359
  'carnero', 'borrego cimarrón', 'íbice', 'alcélafo', 'impala', 'gacela', 'dromedario', 'llama', 'comadreja', 'visón', 'turón', 'hurón de patas negras',
  // 360–371
  'nutria', 'mofeta', 'tejón', 'armadillo', 'perezoso de tres dedos', 'orangután', 'gorila', 'chimpancé', 'gibón', 'siamang', 'cercopiteco', 'mono patas',
  // 372–383
  'babuino', 'macaco', 'langur', 'colobo', 'mono narigudo', 'tití común', 'capuchino', 'mono aullador', 'mono titi', 'mono araña', 'mono ardilla', 'lémur de cola anillada',
  // 384–395
  'indri', 'elefante asiático', 'elefante africano', 'panda rojo', 'panda gigante', 'barracuda', 'anguila', 'salmón coho', 'pez ángel roca', 'pez payaso', 'esturión', 'pejelagarto',
  // 396–407
  'pez león', 'pez globo', 'ábaco', 'abaya', 'toga académica', 'acordeón', 'guitarra acústica', 'portaaviones', 'avión de pasajeros', 'dirigible', 'altar', 'ambulancia',
  // 408–419
  'vehículo anfibio', 'reloj analógico', 'colmenar', 'delantal', 'cubo de basura', 'fusil de asalto', 'mochila', 'panadería', 'barra de equilibrio', 'globo', 'bolígrafo', 'tirita',
  // 420–431
  'banjo', 'barandilla', 'barra de pesas', 'sillón de barbero', 'barbería', 'granero', 'barómetro', 'barril', 'carretilla', 'pelota de béisbol', 'balón de baloncesto', 'moisés',
  // 432–443
  'fagot', 'gorro de baño', 'toalla de baño', 'bañera', 'coche familiar', 'faro', 'vaso de precipitados', 'gorro de piel de oso', 'botella de cerveza', 'vaso de cerveza', 'espadaña', 'babero',
  // 444–455
  'bicicleta tándem', 'bikini', 'carpeta de anillas', 'prismáticos', 'casita para pájaros', 'cobertizo para barcas', 'bobsleigh', 'corbata bolo', 'cofia', 'estantería', 'librería', 'chapa de botella',
  // 456–467
  'arco', 'pajarita', 'placa conmemorativa', 'sujetador', 'rompeolas', 'peto de armadura', 'escoba', 'cubo', 'hebilla', 'chaleco antibalas', 'tren bala', 'carnicería',
  // 468–479
  'taxi', 'caldero', 'vela', 'cañón', 'canoa', 'abrelatas', 'chaqueta de punto', 'retrovisor', 'tiovivo', 'caja de herramientas', 'cartón de bebida', 'rueda de coche',
  // 480–491
  'cajero automático', 'casete', 'reproductor de casetes', 'castillo', 'catamarán', 'reproductor de CD', 'violonchelo', 'teléfono móvil', 'cadena', 'valla metálica', 'cota de malla', 'motosierra',
  // 492–503
  'arcón', 'chifonier', 'carillón', 'vitrina', 'calcetín de Navidad', 'iglesia', 'cine', 'cuchillo de carnicero', 'vivienda en acantilado', 'capa', 'zueco', 'coctelera',
  // 504–515
  'taza de café', 'cafetera', 'espiral', 'candado de combinación', 'teclado de ordenador', 'confitería', 'buque portacontenedores', 'descapotable', 'sacacorchos', 'corneta', 'bota de vaquero', 'sombrero de vaquero',
  // 516–527
  'cuna mecedora', 'grúa', 'casco de moto', 'caja de madera', 'cuna', 'olla de cocción lenta', 'bola de croquet', 'muleta', 'coraza', 'presa', 'escritorio', 'ordenador de sobremesa',
  // 528–539
  'teléfono de disco', 'pañal', 'reloj digital', 'reloj de pulsera digital', 'mesa de comedor', 'trapo de cocina', 'lavavajillas', 'freno de disco', 'dársena', 'trineo de perros', 'cúpula', 'felpudo',
  // 540–551
  'plataforma petrolífera', 'tambor', 'baqueta', 'mancuerna', 'olla holandesa', 'ventilador eléctrico', 'guitarra eléctrica', 'locomotora eléctrica', 'mueble de televisión', 'sobre', 'cafetera exprés', 'polvos faciales',
  // 552–563
  'boa de plumas', 'archivador', 'barco contraincendios', 'camión de bomberos', 'pantalla de chimenea', 'asta de bandera', 'flauta', 'silla plegable', 'casco de fútbol americano', 'carretilla elevadora', 'fuente', 'pluma estilográfica',
  // 564–575
  'cama con dosel', 'vagón de mercancías', 'trompa', 'sartén', 'abrigo de piel', 'camión de basura', 'máscara antigás', 'surtidor de gasolina', 'copa', 'kart', 'pelota de golf', 'carrito de golf',
  // 576–587
  'góndola', 'gong', 'vestido largo', 'piano de cola', 'invernadero', 'rejilla de radiador', 'supermercado', 'guillotina', 'pasador de pelo', 'laca para el pelo', 'semioruga', 'martillo',
  // 588–599
  'cesto', 'secador de manos', 'ordenador de bolsillo', 'pañuelo', 'disco duro', 'armónica', 'arpa', 'cosechadora', 'hacha de mano', 'funda de pistola', 'cine en casa', 'panal',
  // 600–611
  'gancho', 'miriñaque', 'barra fija', 'carro de caballos', 'reloj de arena', 'iPod', 'plancha', 'calabaza de Halloween', 'vaqueros', 'jeep', 'camiseta', 'puzle',
  // 612–623
  'rickshaw', 'joystick', 'kimono', 'rodillera', 'nudo', 'bata de laboratorio', 'cucharón', 'pantalla de lámpara', 'portátil', 'cortacésped', 'tapa de objetivo', 'abrecartas',
  // 624–635
  'biblioteca', 'bote salvavidas', 'mechero', 'limusina', 'transatlántico', 'pintalabios', 'mocasín', 'loción', 'altavoz', 'lupa', 'aserradero', 'brújula',
  // 636–647
  'saca de correos', 'buzón', 'malla de baile', 'bañador', 'tapa de alcantarilla', 'maraca', 'marimba', 'máscara', 'cerilla', 'árbol de mayo', 'laberinto', 'taza medidora',
  // 648–659
  'botiquín', 'megalito', 'micrófono', 'microondas', 'uniforme militar', 'lechera', 'microbús', 'minifalda', 'monovolumen', 'misil', 'manopla', 'cuenco para mezclar',
  // 660–671
  'casa móvil', 'Ford Model T', 'módem', 'monasterio', 'monitor', 'ciclomotor', 'mortero', 'birrete', 'mezquita', 'mosquitera', 'escúter', 'bicicleta de montaña',
  // 672–683
  'tienda de campaña', 'ratón de ordenador', 'ratonera', 'furgoneta de mudanzas', 'bozal', 'clavo', 'collarín', 'collar', 'tetina', 'notebook (ordenador)', 'obelisco', 'oboe',
  // 684–695
  'ocarina', 'cuentakilómetros', 'filtro de aceite', 'órgano', 'osciloscopio', 'sobrefalda', 'carreta de bueyes', 'mascarilla de oxígeno', 'paquete', 'remo', 'rueda de paletas', 'candado',
  // 696–707
  'pincel', 'pijama', 'palacio', 'flauta de Pan', 'papel de cocina', 'paracaídas', 'barras paralelas', 'banco del parque', 'parquímetro', 'vagón de pasajeros', 'patio', 'cabina telefónica',
  // 708–719
  'pedestal', 'estuche', 'sacapuntas', 'perfume', 'placa de Petri', 'fotocopiadora', 'púa', 'casco prusiano', 'valla de madera', 'camioneta pickup', 'embarcadero', 'hucha',
  // 720–731
  'bote de pastillas', 'almohada', 'pelota de ping-pong', 'molinillo de viento', 'barco pirata', 'jarra', 'cepillo de carpintero', 'planetario', 'bolsa de plástico', 'escurreplatos', 'arado', 'desatascador',
  // 732–743
  'cámara Polaroid', 'poste', 'furgón policial', 'poncho', 'mesa de billar', 'botella de refresco', 'maceta', 'torno de alfarero', 'taladro', 'alfombra de oración', 'impresora', 'prisión',
  // 744–755
  'proyectil', 'proyector', 'disco de hockey', 'saco de boxeo', 'monedero', 'pluma de ave', 'edredón', 'coche de carreras', 'raqueta', 'radiador', 'radio', 'radiotelescopio',
  // 756–767
  'barril de lluvia', 'autocaravana', 'carrete', 'cámara réflex', 'nevera', 'mando a distancia', 'restaurante', 'revólver', 'rifle', 'mecedora', 'asador giratorio', 'goma de borrar',
  // 768–779
  'balón de rugby', 'regla', 'zapatilla deportiva', 'caja fuerte', 'imperdible', 'salero', 'sandalia', 'pareo', 'saxofón', 'vaina de espada', 'báscula', 'autobús escolar',
  // 780–791
  'goleta', 'marcador', 'pantalla', 'tornillo', 'destornillador', 'cinturón de seguridad', 'máquina de coser', 'escudo', 'zapatería', 'biombo japonés', 'cesta de la compra', 'carrito de la compra',
  // 792–803
  'pala', 'gorro de ducha', 'cortina de ducha', 'esquí', 'pasamontañas', 'saco de dormir', 'regla de cálculo', 'puerta corredera', 'máquina tragaperras', 'tubo de buceo', 'moto de nieve', 'quitanieves',
  // 804–815
  'dispensador de jabón', 'balón de fútbol', 'calcetín', 'concentrador solar', 'sombrero mexicano', 'cuenco de sopa', 'barra espaciadora', 'estufa', 'transbordador espacial', 'espátula', 'lancha motora', 'telaraña',
  // 816–827
  'huso', 'deportivo', 'foco', 'escenario', 'locomotora de vapor', 'puente de arco de acero', 'tambor metálico', 'estetoscopio', 'estola', 'muro de piedra', 'cronómetro', 'cocina (fogón)',
  // 828–839
  'colador', 'tranvía', 'camilla', 'sofá cama', 'estupa', 'submarino', 'traje', 'reloj de sol', 'lupa solar', 'gafas de sol', 'crema solar', 'puente colgante',
  // 840–851
  'fregona', 'sudadera', 'bañador de hombre', 'columpio', 'interruptor', 'jeringa', 'lámpara de mesa', 'tanque', 'reproductor de cintas', 'tetera', 'osito de peluche', 'televisor',
  // 852–863
  'pelota de tenis', 'tejado de paja', 'telón', 'dedal', 'trilladora', 'trono', 'tejado de tejas', 'tostadora', 'estanco', 'asiento de inodoro', 'antorcha', 'tótem',
  // 864–875
  'grúa remolque', 'juguetería', 'tractor', 'tráiler', 'bandeja', 'gabardina', 'triciclo', 'trimarán', 'trípode', 'arco de triunfo', 'trolebús', 'trombón',
  // 876–887
  'tina', 'torniquete', 'teclado de máquina de escribir', 'paraguas', 'monociclo', 'piano vertical', 'aspiradora', 'jarrón', 'bóveda', 'terciopelo', 'máquina expendedora', 'vestidura litúrgica',
  // 888–899
  'viaducto', 'violín', 'balón de voleibol', 'gofrera', 'reloj de pared', 'cartera', 'armario', 'avión de combate', 'lavabo', 'lavadora', 'botella de agua', 'jarra de agua',
  // 900–911
  'depósito de agua', 'garrafa de whisky', 'silbato', 'peluca', 'mosquitera de ventana', 'estor', 'corbata', 'botella de vino', 'ala de avión', 'wok', 'cuchara de madera', 'lana',
  // 912–923
  'valla en zigzag', 'naufragio', 'yola', 'yurta', 'página web', 'cómic', 'crucigrama', 'señal de tráfico', 'semáforo', 'sobrecubierta de libro', 'menú', 'plato',
  // 924–935
  'guacamole', 'consomé', 'olla caliente', 'trifle (postre)', 'helado', 'polo (helado)', 'barra de pan', 'bagel', 'pretzel', 'hamburguesa con queso', 'perrito caliente', 'puré de patatas',
  // 936–947
  'repollo', 'brócoli', 'coliflor', 'calabacín', 'calabaza espagueti', 'calabaza bellota', 'calabaza moscada', 'pepino', 'alcachofa', 'pimiento', 'cardo', 'champiñón',
  // 948–959
  'manzana Granny Smith', 'fresa', 'naranja', 'limón', 'higo', 'piña', 'plátano', 'yaca', 'chirimoya', 'granada', 'heno', 'carbonara',
  // 960–971
  'salsa de chocolate', 'masa', 'pastel de carne', 'pizza', 'pastel de pollo', 'burrito', 'vino tinto', 'café expreso', 'taza', 'ponche de huevo', 'montaña alpina', 'burbuja',
  // 972–983
  'acantilado', 'arrecife de coral', 'géiser', 'orilla del lago', 'promontorio', 'banco de arena', 'costa', 'valle', 'volcán', 'jugador de béisbol', 'novio', 'buceador',
  // 984–995
  'colza', 'margarita', 'orquídea zapatito amarillo', 'maíz', 'bellota', 'escaramujo', 'castaña de Indias', 'hongo coral', 'agárico', 'colmenilla falsa', 'falo hediondo', 'estrella de tierra',
  // 996–999
  'maitake', 'boleto (seta)', 'mazorca', 'papel higiénico',
];

/** Rangos e índices de ImageNet que equivalen a una categoría COCO (en español). */
const GROUPS = [
  ['perro', [[151, 268]]],
  ['gato', [[281, 285]]],
  ['pájaro', [[7, 24], [80, 100], [127, 146]]],
  ['oso', [[294, 297]]],
  ['cebra', [[340, 340]]],
  ['elefante', [[101, 101], [385, 386]]],
  ['caballo', [[339, 339]]],
  ['oveja', [[348, 349]]],
  ['vaca', [[345, 346]]],
  ['coche', [407, 436, 468, 511, 609, 627, 656, 661, 717, 751, 817].map((i) => [i, i])],
  ['camión', [555, 569, 675, 864, 867].map((i) => [i, i])],
  ['autobús', [654, 779, 874].map((i) => [i, i])],
  ['moto', [665, 670].map((i) => [i, i])],
  ['bicicleta', [444, 671].map((i) => [i, i])],
  ['avión', [404, 895].map((i) => [i, i])],
  ['barco', [472, 484, 510, 554, 576, 625, 628, 724, 780, 814, 871, 914].map((i) => [i, i])],
  ['tren', [466, 547, 565, 705, 820, 829].map((i) => [i, i])],
];

const INDEX_TO_COCO = new Map();
for (const [coco, ranges] of GROUPS) {
  for (const [a, b] of ranges) for (let i = a; i <= b; i++) INDEX_TO_COCO.set(i, coco);
}

/** Categoría COCO (en español) a la que pertenece una clase de ImageNet, o null. */
export function imagenetToCoco(index) {
  return INDEX_TO_COCO.get(index) || null;
}

/** Categorías COCO que el clasificador puede corregir entre sí. */
export const CORRECTABLE = new Set(GROUPS.map(([c]) => c));

export function imagenetLabel(index, fallback = '') {
  return IMAGENET_ES[index] || fallback || `clase ${index}`;
}
